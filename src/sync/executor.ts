import type { TFile, Vault } from "obsidian";
import { ensureParentFolders } from "../local/ensure-folders";
import { LocalFileChangedError, readStableLocalBytes } from "../local/read-local";
import { RemoteHttpError, RemoteObjectChangedError } from "../remote/errors";
import type { R2Client } from "../remote/r2-client";
import type { StateStore } from "../state/sync-state";
import type { LocalEntry, PreviousEntry, RemoteIdentity, RemoteVersion, SyncOperation } from "./types";

/**
 * The single destructive capability the executor is allowed to request.
 *
 * It is deliberately narrow and plugin-driven rather than the raw `Vault` API: the executor must not
 * be able to perform an irreversible unlink. The implementation is expected to honour the user's
 * "Deleted files" preference (system trash or the vault's `.trash` folder).
 */
export interface VaultFileRemover { trash(file: TFile): Promise<void>; }

/**
 * The merge-base facility, as the executor sees it.
 *
 * It is optional and its failures are swallowed: a snapshot is an optimization for future conflict
 * resolution, never a precondition for a successful transfer. Message-embedding a failure here into
 * an `unresolved` result would turn "we could not remember a base" into "the write is in doubt",
 * which is false.
 */
export interface MergeBaseRecorder {
  /** Records a merge-base snapshot for a path that is now proven converged. */
  record(input: { path: string; baseline: { localVersion: LocalEntry; remoteETag?: string } }): Promise<void>;
}

/** Precise reasons a Vault write cannot proceed; they are not transport or precondition failures. */
export type VaultWriteFailure = "parent-path-is-file" | "folder-create-failed" | "target-path-is-folder";
/** Precise reasons a local removal could not be performed; none of them fall back to a hard unlink. */
export type VaultTrashFailure = "trash-unavailable" | "target-is-folder" | "file-manager-unavailable";
/** Precise reasons a resolution could not be applied to the local file. */
export type ResolutionWriteFailure = "target-missing" | "target-path-is-folder" | "parent-path-is-file" | "folder-create-failed";

export type OperationResult =
  | { status: "applied"; key: string }
  | { status: "stale"; key: string; reason: "local-changed" | "remote-changed" | "conflict-superseded" }
  | { status: "blocked"; key: string; reason: "deletion-not-supported-in-phase-2a" | "missing-remote-etag" | "remote-deletion-requires-version-identity" }
  /** A definitive negative answer: a received 4xx, or a Vault path that cannot hold the write. */
  | { status: "failed"; key: string; error: string; reason?: VaultWriteFailure | VaultTrashFailure | ResolutionWriteFailure; httpStatus?: number }
  /** The outcome of the write is genuinely unknown, or the baseline could not be committed. */
  | { status: "unresolved"; key: string; reason: "ambiguous-put" | "state-commit-failed" }
  /**
   * A resolution whose remote half landed but whose local half could not be completed, because the
   * user edited the file while the PUT was in flight. The remote already holds the resolved content,
   * so this is not a failure and not a success: it needs one more reconciliation, and the baseline
   * was deliberately left uncommitted.
   */
  | { status: "partial"; key: string; reason: "remote-applied-local-changed" };

/**
 * A conditional mismatch is a stale plan, not a plugin error. A received 4xx means the write
 * definitely did not happen. Only 5xx/429 responses and a request that never completed
 * ({@link RemoteTransportError}) leave the outcome of a write genuinely unknown, and those stay
 * fail-safe as `unresolved`.
 */
function uploadFailure(operation: string, key: string, error: unknown): OperationResult {
  if (error instanceof RemoteObjectChangedError) return { status: "stale", key, reason: "remote-changed" };
  if (error instanceof RemoteHttpError) {
    if (error.status < 500 && error.status !== 429) return { status: "failed", key, error: `R2 ${operation} failed with HTTP ${error.status}`, httpStatus: error.status };
    return { status: "unresolved", key, reason: "ambiguous-put" };
  }
  // No response was received, so the write may or may not have landed. The same applies to any
  // unexpected failure: claiming "failed" would be a guess, so the outcome stays unknown.
  return { status: "unresolved", key, reason: "ambiguous-put" };
}

function same(stat: { size: number; mtime: number } | null, expected: LocalEntry): boolean { return Boolean(stat && stat.size === expected.size && stat.mtime === expected.mtime); }
async function localStillMatches(vault: Vault, key: string, expected: LocalEntry | { kind: "absent" }): Promise<boolean> {
  if ("kind" in expected) return vault.getFileByPath(key) === null;
  return same(await vault.adapter.stat(expected.key), expected);
}
function message(error: unknown): string { return error instanceof Error ? error.message.slice(0, 180) : "unknown error"; }

/** Sequentially executed, deliberately unexposed executor: callers must supply an already-observed plan. */
export class SafeExecutor {
  constructor(
    private readonly vault: Vault,
    private readonly r2: R2Client,
    private readonly state: StateStore,
    private readonly identity: RemoteIdentity,
    private readonly ignorePolicy: string,
    private readonly files?: VaultFileRemover,
    private readonly mergeBase?: MergeBaseRecorder,
  ) {}

  async execute(operation: SyncOperation): Promise<OperationResult> {
    // Remote deletion stays blocked. R2's DeleteObject has no conditional form, so it cannot name the
    // exact version it intends to remove; an unconditional DELETE could destroy a version another
    // writer created after our scan. It needs a version-identity protocol, not a shortcut.
    if (operation.type === "delete-remote") return { status: "blocked", key: operation.key, reason: "remote-deletion-requires-version-identity" };
    if (operation.type === "prune-baseline") return this.prune(operation.key);
    if (operation.type === "delete-local") return this.deleteLocal(operation);
    if (operation.type === "resolve-keep-local") return this.resolveKeepLocal(operation);
    if (operation.type === "resolve-keep-remote") return this.resolveKeepRemote(operation);
    if (operation.type === "resolve-merged") return this.resolveMerged(operation);
    if (operation.type !== "upload" && operation.type !== "download") return { status: "failed", key: operation.key, error: `operation ${operation.type} is not executable` };
    return operation.type === "upload" ? this.upload(operation) : this.download(operation);
  }

  /**
   * Forgets a baseline entry for a key that is provably absent both locally and remotely.
   *
   * This is bookkeeping, not deletion: no Vault file and no R2 object is touched. It exists so that a
   * converged absence stops occupying the plan forever, which is what previously required wiping the
   * entire device store by hand.
   */
  private async prune(key: string): Promise<OperationResult> {
    try { await this.state.delete(key); return { status: "applied", key }; }
    catch { return { status: "unresolved", key, reason: "state-commit-failed" }; }
  }

  /**
   * Propagates a remote deletion to the local file, recovery-first.
   *
   * The ordering is the whole safety argument:
   *
   * 1. revalidate the local version recorded by the scan, immediately before acting;
   * 2. only then ask the FileManager to trash it, honouring the user's "Deleted files" preference;
   * 3. never fall back to a permanent unlink.
   */
  private async deleteLocal(operation: Extract<SyncOperation, { type: "delete-local" }>): Promise<OperationResult> {
    const expected = operation.expectedLocal;
    if (!(await localStillMatches(this.vault, operation.key, expected))) {
      if (this.vault.getFileByPath(operation.key) === null) return this.pruneResult(operation.key);
      return { status: "stale", key: operation.key, reason: "local-changed" };
    }
    const file = this.vault.getFileByPath(operation.key);
    if (!file) return this.pruneResult(operation.key);
    if (!this.files) return { status: "failed", key: operation.key, error: "no Vault file remover is configured", reason: "file-manager-unavailable" };
    try { await this.files.trash(file); }
    catch (error) { return { status: "failed", key: operation.key, error: message(error), reason: "trash-unavailable" }; }
    if (this.vault.getFileByPath(operation.key) !== null) return { status: "failed", key: operation.key, error: "the file is still present after the trash operation", reason: "trash-unavailable" };
    return this.pruneResult(operation.key);
  }

  private async pruneResult(key: string): Promise<OperationResult> {
    try { await this.state.delete(key); return { status: "applied", key }; }
    catch { return { status: "unresolved", key, reason: "state-commit-failed" }; }
  }

  // ---- conflict resolution ----------------------------------------------------------------------

  /**
   * "Keep local" means: make the local content L that the user saw the remote content, replacing only
   * the remote version R the user also saw.
   *
   * The conditional PUT against `expectedRemoteETag` is what enforces "only R": if any writer moved
   * the remote since the conflict was recorded, R2 answers 412 and nothing is overwritten.
   */
  private async resolveKeepLocal(operation: Extract<SyncOperation, { type: "resolve-keep-local" }>): Promise<OperationResult> {
    if (!operation.expectedRemoteETag) return { status: "blocked", key: operation.key, reason: "missing-remote-etag" };
    // The user's decision is only valid for the local version they were shown.
    if (!(await localStillMatches(this.vault, operation.key, operation.expectedLocal))) return { status: "stale", key: operation.key, reason: "conflict-superseded" };
    let bytes: ArrayBuffer;
    try { bytes = await readStableLocalBytes(this.vault, operation.expectedLocal); }
    catch (error) { return error instanceof LocalFileChangedError ? { status: "stale", key: operation.key, reason: "local-changed" } : { status: "failed", key: operation.key, error: message(error) }; }
    let remote: RemoteVersion;
    try { remote = await this.r2.putObject(operation.key, bytes, { ifMatch: operation.expectedRemoteETag }); }
    catch (error) { return uploadFailure("PutObject", operation.key, error); }
    // The remote now holds L. If the local file moved on during the PUT, the baseline cannot describe
    // both sides, so it is left uncommitted and the next reconciliation picks the divergence up.
    const localStat = await this.vault.adapter.stat(operation.key);
    if (!same(localStat, operation.expectedLocal)) return { status: "partial", key: operation.key, reason: "remote-applied-local-changed" };
    const version = { size: localStat!.size, mtime: localStat!.mtime };
    const commit = await this.commit({ key: operation.key, local: version, remote, syncedAt: Date.now(), remoteIdentity: this.identity, ignorePolicy: this.ignorePolicy });
    if (commit) return commit;
    await this.recordMergeBase(operation.key, { localVersion: { key: operation.key, ...version }, remoteETag: remote.etag });
    return { status: "applied", key: operation.key };
  }

  /**
   * "Keep remote" means: make the remote content R the user saw the local content, replacing exactly
   * the local version L they saw.
   *
   * The GET is conditional on R's ETag, so a remote that moved on is detected before anything local is
   * touched. It produces no R2 mutation, and therefore must not notify the Gateway.
   */
  private async resolveKeepRemote(operation: Extract<SyncOperation, { type: "resolve-keep-remote" }>): Promise<OperationResult> {
    if (!operation.expectedRemoteETag) return { status: "blocked", key: operation.key, reason: "missing-remote-etag" };
    if (!(await localStillMatches(this.vault, operation.key, operation.expectedLocal))) return { status: "stale", key: operation.key, reason: "conflict-superseded" };
    let bytes: ArrayBuffer;
    try { bytes = await this.r2.getObject(operation.key, { ifMatch: operation.expectedRemoteETag }); } catch (error) {
      if (error instanceof RemoteObjectChangedError) return { status: "stale", key: operation.key, reason: "remote-changed" };
      return error instanceof RemoteHttpError
        ? { status: "failed", key: operation.key, error: message(error), httpStatus: error.status }
        : { status: "failed", key: operation.key, error: message(error) };
    }
    // Fetching widened the window, so the local precondition is confirmed again before the overwrite.
    if (!(await localStillMatches(this.vault, operation.key, operation.expectedLocal))) return { status: "stale", key: operation.key, reason: "local-changed" };
    const written = await this.writeLocal(operation.key, bytes);
    if ("status" in written) return written;
    const commit = await this.commit({ key: operation.key, local: written.version, remote: { size: bytes.byteLength, etag: operation.expectedRemoteETag }, syncedAt: Date.now(), remoteIdentity: this.identity, ignorePolicy: this.ignorePolicy });
    if (commit) return commit;
    await this.recordMergeBase(operation.key, { localVersion: { key: operation.key, ...written.version }, remoteETag: operation.expectedRemoteETag });
    return { status: "applied", key: operation.key };
  }

  /**
   * Applies a merged result M to both sides.
   *
   * Order matters, and so does the partial-success case. The remote is updated first with a
   * conditional PUT, because that is the side another device can observe and because R2 is the only
   * place a precondition can be enforced. If the local write then cannot complete — the user edited
   * the file while the PUT was in flight — the remote is **never** rolled back (that is impossible and
   * would be its own data loss), no baseline is committed for a state that does not exist, and the
   * result is reported as `partial` so the next reconciliation resolves the new divergence normally.
   */
  private async resolveMerged(operation: Extract<SyncOperation, { type: "resolve-merged" }>): Promise<OperationResult> {
    if (!operation.expectedRemoteETag) return { status: "blocked", key: operation.key, reason: "missing-remote-etag" };
    if (!(await localStillMatches(this.vault, operation.key, operation.expectedLocal))) return { status: "stale", key: operation.key, reason: "conflict-superseded" };
    const mergedBytes = encodeMerged(operation.merged);
    let remote: RemoteVersion;
    try { remote = await this.r2.putObject(operation.key, mergedBytes, { ifMatch: operation.expectedRemoteETag }); }
    catch (error) { return uploadFailure("PutObject", operation.key, error); }
    // The remote holds M. Re-check the local precondition before overwriting the user's file.
    if (!(await localStillMatches(this.vault, operation.key, operation.expectedLocal))) return { status: "partial", key: operation.key, reason: "remote-applied-local-changed" };
    const written = await this.writeLocal(operation.key, mergedBytes);
    if ("status" in written) return { status: "partial", key: operation.key, reason: "remote-applied-local-changed" };
    const commit = await this.commit({ key: operation.key, local: written.version, remote, syncedAt: Date.now(), remoteIdentity: this.identity, ignorePolicy: this.ignorePolicy });
    if (commit) return commit;
    await this.recordMergeBase(operation.key, { localVersion: { key: operation.key, ...written.version }, remoteETag: remote.etag });
    return { status: "applied", key: operation.key };
  }

  /**
   * Writes bytes to a Vault path, creating parents if needed. Unlike the download path, a
   * resolution always has an existing local file (the conflict was observed on it), so a missing
   * target is reported rather than recreated.
   */
  private async writeLocal(key: string, bytes: ArrayBuffer): Promise<{ version: { size: number; mtime: number } } | OperationResult> {
    const file = this.vault.getFileByPath(key);
    if (!file) {
      if (this.vault.getAbstractFileByPath(key) !== null) return { status: "failed", key, error: `Vault path "${key}" is a folder, not a file`, reason: "target-path-is-folder" };
      return { status: "failed", key, error: "the conflicted local file no longer exists", reason: "target-missing" };
    }
    try { await this.vault.modifyBinary(file, bytes); }
    catch (error) { return { status: "failed", key, error: message(error) }; }
    const local = await this.vault.adapter.stat(key);
    if (!local) return { status: "failed", key, error: "Vault write did not produce a file" };
    return { version: { size: local.size, mtime: local.mtime } };
  }

  private async recordMergeBase(key: string, baseline: { localVersion: LocalEntry; remoteETag?: string }): Promise<void> {
    if (!this.mergeBase) return;
    // A snapshot is a facility for a future conflict, not part of this write's correctness, so its
    // failure is contained here and never becomes the operation's result.
    try { await this.mergeBase.record({ path: key, baseline }); } catch { /* snapshot unavailable; merge ability degrades only */ }
  }

  private async commit(entry: PreviousEntry): Promise<OperationResult | undefined> {
    try { await this.state.put(entry); return undefined; } catch { return { status: "unresolved", key: entry.key, reason: "state-commit-failed" }; }
  }

  // ---- transfers --------------------------------------------------------------------------------

  private async upload(operation: Extract<SyncOperation, { type: "upload" }>): Promise<OperationResult> {
    if (operation.expectedRemote.kind === "etag" && !operation.expectedRemote.value) return { status: "blocked", key: operation.key, reason: "missing-remote-etag" };
    let bytes: ArrayBuffer;
    try { bytes = await readStableLocalBytes(this.vault, operation.expectedLocal); } catch (error) { return error instanceof LocalFileChangedError ? { status: "stale", key: operation.key, reason: "local-changed" } : { status: "failed", key: operation.key, error: message(error) }; }
    try {
      const remote = await this.r2.putObject(operation.key, bytes, operation.expectedRemote.kind === "absent" ? { ifNoneMatch: "*" } : { ifMatch: operation.expectedRemote.value! });
      const localStat = await this.vault.adapter.stat(operation.key);
      if (!same(localStat, operation.expectedLocal)) return { status: "stale", key: operation.key, reason: "local-changed" };
      const version = { size: localStat!.size, mtime: localStat!.mtime };
      const commit = await this.commit({ key: operation.key, local: version, remote, syncedAt: Date.now(), remoteIdentity: this.identity, ignorePolicy: this.ignorePolicy });
      if (commit) return commit;
      await this.recordMergeBase(operation.key, { localVersion: { key: operation.key, ...version }, remoteETag: remote.etag });
      return { status: "applied", key: operation.key };
    } catch (error) {
      return uploadFailure("PutObject", operation.key, error);
    }
  }
  private async download(operation: Extract<SyncOperation, { type: "download" }>): Promise<OperationResult> {
    if (!operation.expectedRemote.etag) return { status: "blocked", key: operation.key, reason: "missing-remote-etag" };
    if (!(await localStillMatches(this.vault, operation.key, operation.expectedLocal))) return { status: "stale", key: operation.key, reason: "local-changed" };
    let bytes: ArrayBuffer;
    try { bytes = await this.r2.getObject(operation.key, { ifMatch: operation.expectedRemote.etag }); } catch (error) {
      if (error instanceof RemoteObjectChangedError) return { status: "stale", key: operation.key, reason: "remote-changed" };
      return error instanceof RemoteHttpError
        ? { status: "failed", key: operation.key, error: message(error), httpStatus: error.status }
        : { status: "failed", key: operation.key, error: message(error) };
    }
    // Local side effects stay as late as possible: a failed download must not create folders.
    if (!(await localStillMatches(this.vault, operation.key, operation.expectedLocal))) return { status: "stale", key: operation.key, reason: "local-changed" };
    try {
      const file = this.vault.getFileByPath(operation.key);
      if (file) {
        await this.vault.modifyBinary(file, bytes);
      } else {
        if (this.vault.getAbstractFileByPath(operation.key) !== null) return { status: "failed", key: operation.key, reason: "target-path-is-folder", error: `Vault path "${operation.key}" is a folder, not a file` };
        // Vault.createBinary does not create missing parent folders, so the chain is made first.
        const folders = await ensureParentFolders(this.vault, operation.key);
        if (!folders.ok) return { status: "failed", key: operation.key, reason: folders.reason, error: folders.error };
        // Creating folders widens the race window, so the target is confirmed once more.
        if (!(await localStillMatches(this.vault, operation.key, operation.expectedLocal))) return { status: "stale", key: operation.key, reason: "local-changed" };
        await this.vault.createBinary(operation.key, bytes);
      }
      const local = await this.vault.adapter.stat(operation.key);
      if (!local) return { status: "failed", key: operation.key, error: "Vault write did not produce a file" };
      const version = { size: local.size, mtime: local.mtime };
      const commit = await this.commit({ key: operation.key, local: version, remote: operation.expectedRemote, syncedAt: Date.now(), remoteIdentity: this.identity, ignorePolicy: this.ignorePolicy });
      if (commit) return commit;
      await this.recordMergeBase(operation.key, { localVersion: { key: operation.key, ...version }, remoteETag: operation.expectedRemote.etag });
      return { status: "applied", key: operation.key };
    } catch (error) { return { status: "failed", key: operation.key, error: message(error) }; }
  }
}

/** Re-encodes a merged intent's normalized content into the shape the user's file should have. */
function encodeMerged(merged: Extract<SyncOperation, { type: "resolve-merged" }>["merged"]): ArrayBuffer {
  let text = merged.content;
  if (!merged.encoding.trailingNewline && text.endsWith("\n")) text = text.slice(0, -1);
  else if (merged.encoding.trailingNewline && text !== "" && !text.endsWith("\n")) text += "\n";
  if (merged.encoding.eol === "crlf") text = text.replace(/\n/g, "\r\n");
  if (merged.encoding.bom) text = `\uFEFF${text}`;
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
