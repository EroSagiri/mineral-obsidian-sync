import type { TFile, Vault } from "obsidian";
import { ensureParentFolders } from "../local/ensure-folders";
import { LocalFileChangedError, readStableLocalBytes } from "../local/read-local";
import { RemoteHttpError, RemoteObjectChangedError } from "../remote/errors";
import type { R2Client } from "../remote/r2-client";
import type { StateStore } from "../state/sync-state";
import type { LocalEntry, PreviousEntry, RemoteIdentity, SyncOperation } from "./types";

/**
 * The single destructive capability the executor is allowed to request.
 *
 * It is deliberately narrow and plugin-driven rather than the raw `Vault` API: the executor must not
 * be able to perform an irreversible unlink. The implementation is expected to honour the user's
 * "Deleted files" preference (system trash or the vault's `.trash` folder).
 */
export interface VaultFileRemover { trash(file: TFile): Promise<void>; }

/** Precise reasons a Vault write cannot proceed; they are not transport or precondition failures. */
export type VaultWriteFailure = "parent-path-is-file" | "folder-create-failed" | "target-path-is-folder";
/** Precise reasons a local removal could not be performed; none of them fall back to a hard unlink. */
export type VaultTrashFailure = "trash-unavailable" | "target-is-folder" | "file-manager-unavailable";

export type OperationResult =
  | { status: "applied"; key: string }
  | { status: "stale"; key: string; reason: "local-changed" | "remote-changed" }
  | { status: "blocked"; key: string; reason: "deletion-not-supported-in-phase-2a" | "missing-remote-etag" | "remote-deletion-requires-version-identity" }
  /** A definitive negative answer: a received 4xx, or a Vault path that cannot hold the write. */
  | { status: "failed"; key: string; error: string; reason?: VaultWriteFailure | VaultTrashFailure; httpStatus?: number }
  /** The outcome of the write is genuinely unknown, or the baseline could not be committed. */
  | { status: "unresolved"; key: string; reason: "ambiguous-put" | "state-commit-failed" };

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

/** Sequential, deliberately unexposed executor: callers must supply an already-observed plan. */
export class SafeExecutor {
  constructor(private readonly vault: Vault, private readonly r2: R2Client, private readonly state: StateStore, private readonly identity: RemoteIdentity, private readonly ignorePolicy: string, private readonly files?: VaultFileRemover) {}

  async execute(operation: SyncOperation): Promise<OperationResult> {
    // Remote deletion stays blocked. R2's DeleteObject has no conditional form, so it cannot name the
    // exact version it intends to remove; an unconditional DELETE could destroy a version another
    // writer created after our scan. It needs a version-identity protocol, not a shortcut.
    if (operation.type === "delete-remote") return { status: "blocked", key: operation.key, reason: "remote-deletion-requires-version-identity" };
    if (operation.type === "prune-baseline") return this.prune(operation.key);
    if (operation.type === "delete-local") return this.deleteLocal(operation);
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
   *
   * A file that became L2 after the scan planned L1 is reported `stale`, never removed — the
   * destructive action is always gated on the version it was decided from.
   */
  private async deleteLocal(operation: Extract<SyncOperation, { type: "delete-local" }>): Promise<OperationResult> {
    const expected = operation.expectedLocal;
    // Step 1: the file must still be exactly what the scan saw.
    if (!(await localStillMatches(this.vault, operation.key, expected))) {
      // Absent already means the deletion is effectively done; changed means the user moved on.
      if (this.vault.getFileByPath(operation.key) === null) return this.pruneResult(operation.key);
      return { status: "stale", key: operation.key, reason: "local-changed" };
    }
    const file = this.vault.getFileByPath(operation.key);
    if (!file) return this.pruneResult(operation.key);
    if (!this.files) return { status: "failed", key: operation.key, error: "no Vault file remover is configured", reason: "file-manager-unavailable" };
    // Step 2: recovery-first removal. No permanent unlink path exists here on purpose.
    try { await this.files.trash(file); }
    catch (error) { return { status: "failed", key: operation.key, error: message(error), reason: "trash-unavailable" }; }
    if (this.vault.getFileByPath(operation.key) !== null) return { status: "failed", key: operation.key, error: "the file is still present after the trash operation", reason: "trash-unavailable" };
    // Step 3: both sides are now absent, so the baseline describes nothing and is retired.
    return this.pruneResult(operation.key);
  }

  private async pruneResult(key: string): Promise<OperationResult> {
    try { await this.state.delete(key); return { status: "applied", key }; }
    catch { return { status: "unresolved", key, reason: "state-commit-failed" }; }
  }

  private async commit(entry: PreviousEntry): Promise<OperationResult | undefined> {
    try { await this.state.put(entry); return undefined; } catch { return { status: "unresolved", key: entry.key, reason: "state-commit-failed" }; }
  }
  private async upload(operation: Extract<SyncOperation, { type: "upload" }>): Promise<OperationResult> {
    if (operation.expectedRemote.kind === "etag" && !operation.expectedRemote.value) return { status: "blocked", key: operation.key, reason: "missing-remote-etag" };
    let bytes: ArrayBuffer;
    try { bytes = await readStableLocalBytes(this.vault, operation.expectedLocal); } catch (error) { return error instanceof LocalFileChangedError ? { status: "stale", key: operation.key, reason: "local-changed" } : { status: "failed", key: operation.key, error: message(error) }; }
    try {
      const remote = await this.r2.putObject(operation.key, bytes, operation.expectedRemote.kind === "absent" ? { ifNoneMatch: "*" } : { ifMatch: operation.expectedRemote.value! });
      const localStat = await this.vault.adapter.stat(operation.key);
      if (!same(localStat, operation.expectedLocal)) return { status: "stale", key: operation.key, reason: "local-changed" };
      const commit = await this.commit({ key: operation.key, local: { size: localStat!.size, mtime: localStat!.mtime }, remote, syncedAt: Date.now(), remoteIdentity: this.identity, ignorePolicy: this.ignorePolicy });
      return commit ?? { status: "applied", key: operation.key };
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
      const commit = await this.commit({ key: operation.key, local: { size: local.size, mtime: local.mtime }, remote: operation.expectedRemote, syncedAt: Date.now(), remoteIdentity: this.identity, ignorePolicy: this.ignorePolicy });
      return commit ?? { status: "applied", key: operation.key };
    } catch (error) { return { status: "failed", key: operation.key, error: message(error) }; }
  }
}
