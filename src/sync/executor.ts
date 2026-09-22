import type { TFile, Vault } from "obsidian";
import { ensureParentFolders } from "../local/ensure-folders";
import { LocalFileChangedError, readCurrentStableLocalBytes, readStableLocalBytes } from "../local/read-local";
import { RemoteHttpError, RemoteObjectChangedError } from "../remote/errors";
import type { R2Client } from "../remote/r2-client";
import { TOMBSTONE_PROTOCOL, type RemoteTombstone } from "../remote/tombstones";
import type { StateStore } from "../state/sync-state";
import type { LocalEntry, PreviousEntry, RemoteIdentity, RemoteVersion, SyncOperation } from "./types";
import { sha256 } from "./fingerprint";

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

/**
 * Why a transfer left the two sides in a state this device must not claim is converged.
 *
 * The distinction that matters to the scheduler is not *what* went wrong but whether a side effect may
 * exist that nobody has accounted for. Every `partial` is such a case, which is why a `partial` makes
 * a cycle's remote observation incomplete and no Gateway generation may be retired from it.
 */
export type PartialReason =
  /** A conditional PUT landed and the local half (the catch-up, or the resolved write) did not. */
  | "remote-applied-local-changed"
  /** A completed local write was superseded by an editor save before its content could be verified. */
  | "remote-write-raced-with-local-edit"
  /** A local write was attempted and whether it landed cannot be established. */
  | "remote-write-landing-unknown";

export type OperationResult =
  | { status: "applied"; key: string; /** Exact Vault version written by this executor, if it wrote locally. */ localWrite?: LocalEntry }
  | { status: "stale"; key: string; reason: "local-changed" | "remote-changed" | "conflict-superseded" }
  | { status: "blocked"; key: string; reason: "deletion-not-supported-in-phase-2a" | "missing-remote-etag" | "remote-deletion-requires-version-identity" }
  /** A definitive negative answer: a received 4xx, or a Vault path that cannot hold the write. */
  | { status: "failed"; key: string; error: string; reason?: VaultWriteFailure | VaultTrashFailure | ResolutionWriteFailure; httpStatus?: number }
  /** The outcome of the write is genuinely unknown, or the baseline could not be committed. */
  | { status: "unresolved"; key: string; reason: "ambiguous-put" | "state-commit-failed" }
  /**
   * A transfer that may have left a side effect this device cannot describe with a baseline.
   *
   * A `failed` is a promise that nothing needs recovering; a `partial` is the absence of that promise.
   * The remote half may have landed (a conditional PUT that this device authored, or the resolved
   * content another device can already see), or a local write's landing may be unknown, or a local
   * write was proven superseded by the user. In every case exactly one more reconciliation is needed,
   * and the caller must not treat the remote window as fully observed.
   */
  | { status: "partial"; key: string; reason: PartialReason; error?: string };

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

/**
 * A short, non-reversible digest of a path.
 *
 * Debug telemetry in this plugin deliberately never carries a key, and this is how the two constraints
 * — "say which path this was about" and "never log a path" — are reconciled: the digest is stable for
 * correlation within a session and reveals nothing on its own. FNV-1a keeps this synchronous, so a
 * diagnostic can never add an await to a transfer.
 */
export function pathDigest(key: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const shortEtag = (etag: string | undefined): string => etag ? `${etag.slice(0, 8)}…` : "none";

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
    private readonly debug?: (message: string) => void,
  ) {}

  /** Diagnostic categories only: never a key, never content, never request metadata. */
  private log(message: string): void { this.debug?.(message); }

  async execute(operation: SyncOperation): Promise<OperationResult> {
    if (operation.type === "delete-remote") return this.deleteRemote(operation);
    if (operation.type === "prune-baseline") return this.prune(operation.key);
    if (operation.type === "delete-local") return this.deleteLocal(operation);
    if (operation.type === "resolve-keep-local") return this.resolveKeepLocal(operation);
    if (operation.type === "resolve-keep-remote") return this.resolveKeepRemote(operation);
    if (operation.type === "resolve-merged") return this.resolveMerged(operation);
    if (operation.type === "resolve-accept-remote-delete") return this.acceptRemoteDelete(operation);
    if (operation.type === "resolve-accept-local-delete") return this.deleteRemote({ type: "delete-remote", key: operation.key, reason: operation.reason, expectedRemoteETag: operation.expectedRemoteETag });
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

  /**
   * Propagates a local deletion without issuing DeleteObject. A conditional HEAD proves the exact
   * scanned version is still current; the immutable tombstone then makes only that version absent.
   * If the tombstone PUT is ambiguous, no baseline is retired and the next full scan decides truth.
   */
  private async deleteRemote(operation: Extract<SyncOperation, { type: "delete-remote" }>): Promise<OperationResult> {
    const etag = operation.expectedRemoteETag;
    if (!etag) return { status: "blocked", key: operation.key, reason: "missing-remote-etag" };
    if (!this.r2.putTombstone) return { status: "blocked", key: operation.key, reason: "remote-deletion-requires-version-identity" };
    try {
      await this.r2.headObject(operation.key, { ifMatch: etag });
    } catch (error) {
      if (error instanceof RemoteObjectChangedError) return { status: "stale", key: operation.key, reason: "remote-changed" };
      return error instanceof RemoteHttpError ? { status: "failed", key: operation.key, error: message(error), httpStatus: error.status } : { status: "failed", key: operation.key, error: message(error) };
    }
    const record: RemoteTombstone = { protocol: TOMBSTONE_PROTOCOL, path: operation.key, deletedRemoteETag: etag, createdAt: new Date().toISOString() };
    try {
      await this.r2.putTombstone(record);
    } catch (error) {
      // A received 4xx means no record was accepted; a transport failure or 5xx remains ambiguous.
      if (error instanceof RemoteObjectChangedError) return { status: "stale", key: operation.key, reason: "remote-changed" };
      return uploadFailure("PutObject tombstone", operation.key, error);
    }
    return this.pruneResult(operation.key);
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
    if (!operation.expectedRemoteETag && !operation.expectedRemoteAbsent) return { status: "blocked", key: operation.key, reason: "missing-remote-etag" };
    // The user's decision is only valid for the local version they were shown.
    if (!(await localStillMatches(this.vault, operation.key, operation.expectedLocal))) return { status: "stale", key: operation.key, reason: "conflict-superseded" };
    let bytes: ArrayBuffer;
    try { bytes = await readStableLocalBytes(this.vault, operation.expectedLocal); }
    catch (error) { return error instanceof LocalFileChangedError ? { status: "stale", key: operation.key, reason: "local-changed" } : { status: "failed", key: operation.key, error: message(error) }; }
    let remote: RemoteVersion;
    try { remote = await this.r2.putObject(operation.key, bytes, operation.expectedRemoteAbsent ? { ifNoneMatch: "*" } : { ifMatch: operation.expectedRemoteETag! }); }
    catch (error) { return uploadFailure("PutObject", operation.key, error); }
    // The remote now holds L, which `bytes` were read from `expectedLocal`: recording that pair is the
    // same invariant every other landed PUT has. Leaving it uncommitted is what makes the device's own
    // resolution read as a remote concurrent edit on the next cycle.
    const floor = await this.commitFloorBaseline(operation.key, operation.expectedLocal, remote);
    if (floor) return floor;
    await this.recordMergeBase(operation.key, { localVersion: operation.expectedLocal, remoteETag: remote.etag });
    // The confirmation only decides whether the *newest* local version is accounted for as well.
    if (!same(await this.vault.adapter.stat(operation.key), operation.expectedLocal)) return { status: "partial", key: operation.key, reason: "remote-applied-local-changed" };
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
    const written = await this.writeLocal(operation.key, bytes, "kind" in operation.expectedLocal);
    if ("status" in written) return written;
    const commit = await this.commit({ key: operation.key, local: written.version, remote: { size: bytes.byteLength, etag: operation.expectedRemoteETag }, syncedAt: Date.now(), remoteIdentity: this.identity, ignorePolicy: this.ignorePolicy });
    if (commit) return commit;
    await this.recordMergeBase(operation.key, { localVersion: { key: operation.key, ...written.version }, remoteETag: operation.expectedRemoteETag });
    return { status: "applied", key: operation.key, localWrite: { key: operation.key, ...written.version } };
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
    return { status: "applied", key: operation.key, localWrite: { key: operation.key, ...written.version } };
  }

  /**
   * Writes bytes to a Vault path, creating parents if needed. Unlike the download path, a
   * resolution always has an existing local file (the conflict was observed on it), so a missing
   * target is reported rather than recreated.
   */
  private async acceptRemoteDelete(operation: Extract<SyncOperation, { type: "resolve-accept-remote-delete" }>): Promise<OperationResult> {
    // Reconfirm the physical object still is the version named by the tombstone. A later B object
    // survives tombstone(A), and must also stop an old "accept delete" click from trashing local B.
    if (operation.expectedDeletion.objectPresent) try { await this.r2.headObject(operation.key, { ifMatch: operation.expectedDeletion.deletedRemoteETag }); }
    catch (error) {
      if (error instanceof RemoteObjectChangedError) return { status: "stale", key: operation.key, reason: "conflict-superseded" };
      return error instanceof RemoteHttpError ? { status: "failed", key: operation.key, error: message(error), httpStatus: error.status } : { status: "failed", key: operation.key, error: message(error) };
    }
    // The local version is checked again by deleteLocal immediately before the recovery-first trash.
    return this.deleteLocal({ type: "delete-local", key: operation.key, reason: operation.reason, expectedLocal: operation.expectedLocal });
  }

  private async writeLocal(key: string, bytes: ArrayBuffer, allowCreate = false): Promise<{ version: { size: number; mtime: number } } | OperationResult> {
    const file = this.vault.getFileByPath(key);
    if (!file) {
      if (this.vault.getAbstractFileByPath(key) !== null) return { status: "failed", key, error: `Vault path "${key}" is a folder, not a file`, reason: "target-path-is-folder" };
      if (!allowCreate) return { status: "failed", key, error: "the conflicted local file no longer exists", reason: "target-missing" };
      const folders = await ensureParentFolders(this.vault, key);
      if (!folders.ok) return { status: "failed", key, error: folders.error, reason: folders.reason };
      if (this.vault.getFileByPath(key)) return { status: "stale", key, reason: "local-changed" };
      try { await this.vault.createBinary(key, bytes); }
      catch (error) { return this.landingUnknown(key, error); }
    } else {
      try { await this.vault.modifyBinary(file, bytes); }
      catch (error) { return this.landingUnknown(key, error); }
    }
    const local = await this.vault.adapter.stat(key);
    // The write was attempted; whether it landed is exactly what an unreadable stat leaves unknown.
    if (!local) return this.landingUnknown(key, new Error("Vault write did not produce a file"));
    return { version: { size: local.size, mtime: local.mtime } };
  }

  /**
   * A local write whose landing cannot be established is never a definitive failure: the scheduler must
   * not retire a remote generation on a result that proves nothing about the local side. It is reported
   * as `partial`, which keeps the window incomplete and lets the next reconciliation observe the truth.
   */
  private landingUnknown(key: string, error: unknown): OperationResult {
    this.log(`local write landing unknown path-digest=${pathDigest(key)} result=partial`);
    return { status: "partial", key, reason: "remote-write-landing-unknown", error: message(error) };
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

  /**
   * Commits the baseline a landed conditional PUT proves: this exact local version, now equal to the
   * remote version that PUT produced.
   *
   * It is called *before* the executor looks at the file again, because the fact it records is a
   * property of the completed transfer rather than of the file's current state. A `state-commit-failed`
   * is returned as `unresolved` for the caller to surface: a transfer whose baseline could not be
   * remembered is not a converged transfer.
   */
  private async commitFloorBaseline(key: string, local: LocalEntry, remote: RemoteVersion): Promise<OperationResult | undefined> {
    const result = await this.commit({ key, local: { size: local.size, mtime: local.mtime }, remote, syncedAt: Date.now(), remoteIdentity: this.identity, ignorePolicy: this.ignorePolicy });
    if (!result) this.log(`floor-baseline committed path-digest=${pathDigest(key)} etag=${shortEtag(remote.etag)}`);
    return result;
  }

  /**
   * Uploads the exact local version the planner observed, with the conditional PUT as its only
   * precondition.
   *
   * The ordering after a successful PUT is the whole safety argument:
   *
   * 1. commit a **floor baseline** for the version that was actually sent, immediately, before anything
   *    else can fail. The PUT landed, so at that instant the local file provably held those bytes and
   *    R2 provably holds them — exactly the fact a baseline asserts, and one that stays true whatever
   *    the editor does next. Without it, a catch-up failure leaves the *ancestor* as the baseline while
   *    the remote has already advanced to this device's own bytes, and the next cycle reads that as a
   *    remote concurrent edit and reports `both-modified` against itself;
   * 2. only then look at the file again, and offer a newer local version to the catch-up path, which
   *    upgrades the baseline to that newer pair if — and only if — its own conditional PUT lands.
   *
   * A failed catch-up therefore keeps the floor and reports `partial`; it never retracts the fact that
   * the first PUT succeeded.
   */
  private async upload(operation: Extract<SyncOperation, { type: "upload" }>): Promise<OperationResult> {
    if (operation.expectedRemote.kind === "etag" && !operation.expectedRemote.value) return { status: "blocked", key: operation.key, reason: "missing-remote-etag" };
    let bytes: ArrayBuffer;
    try { bytes = await readStableLocalBytes(this.vault, operation.expectedLocal); } catch (error) { return error instanceof LocalFileChangedError ? { status: "stale", key: operation.key, reason: "local-changed" } : { status: "failed", key: operation.key, error: message(error) }; }
    try {
      const remote = await this.r2.putObject(operation.key, bytes, operation.expectedRemote.kind === "absent" ? { ifNoneMatch: "*" } : { ifMatch: operation.expectedRemote.value! });
      this.log(`upload landed path-digest=${pathDigest(operation.key)} etag=${shortEtag(remote.etag)}`);
      const floor = await this.commitFloorBaseline(operation.key, operation.expectedLocal, remote);
      if (floor) return floor;
      await this.recordMergeBase(operation.key, { localVersion: operation.expectedLocal, remoteETag: remote.etag });
      const localStat = await this.vault.adapter.stat(operation.key);
      if (!same(localStat, operation.expectedLocal)) return this.catchUpLatestLocalUpload(operation.key, remote);
      return { status: "applied", key: operation.key };
    } catch (error) {
      return uploadFailure("PutObject", operation.key, error);
    }
  }

  /**
   * The first conditional PUT already landed, but the editor saved a newer local version before it
   * could be accounted for. One conditional catch-up PUT preserves that latest local version without
   * ever overwriting an intervening writer: only the ETag we just received is accepted. On success the
   * baseline is upgraded to the newer pair; on any failure the floor baseline from the first PUT is
   * deliberately left in place.
   */
  private async catchUpLatestLocalUpload(key: string, landedRemote: RemoteVersion): Promise<OperationResult> {
    this.log(`upload catch-up required path-digest=${pathDigest(key)} etag=${shortEtag(landedRemote.etag)}`);
    const partial = (): OperationResult => {
      this.log(`upload catch-up partial path-digest=${pathDigest(key)} floorBaselineRetained=true`);
      return { status: "partial", key, reason: "remote-applied-local-changed" };
    };
    let latest: Awaited<ReturnType<typeof readCurrentStableLocalBytes>>;
    try { latest = await readCurrentStableLocalBytes(this.vault, key); }
    catch { return partial(); }
    try {
      const remote = await this.r2.putObject(key, latest.bytes, { ifMatch: landedRemote.etag });
      this.log(`upload catch-up landed path-digest=${pathDigest(key)} etag=${shortEtag(remote.etag)}`);
      // This PUT landed as well, so the pair it carried is recorded before anything else can fail —
      // the same invariant the first PUT has. It is the newer of the two floors, and without it the
      // device's own catch-up reads as a remote concurrent edit on the next cycle, which is a
      // `both-modified` conflict against itself.
      const floor = await this.commitFloorBaseline(key, latest.version, remote);
      if (floor) return floor;
      await this.recordMergeBase(key, { localVersion: latest.version, remoteETag: remote.etag });
      // The confirmation only decides whether the *newest* local version is accounted for as well.
      if (!same(await this.vault.adapter.stat(key), latest.version)) return partial();
      return { status: "applied", key };
    } catch {
      // The first PUT is known to have landed, so this must be surfaced as a partial result rather
      // than a failure: the floor baseline it committed is the only record of that transfer.
      return partial();
    }
  }

  /**
   * Confirms that a completed local write left behind exactly the bytes the transfer intended, and
   * returns the Vault version those bytes belong to.
   *
   * A `stat` cannot answer this question: it reports a size and a timestamp, and an editor save that
   * lands between the write and the stat would otherwise be recorded as a converged baseline while its
   * content was never compared. That would make the planner see `local == baseline.local` forever and
   * drop the user's edit silently. The check is therefore content-level, over bytes re-read around a
   * stable `stat`, and the returned version is the one the verified bytes actually belong to.
   *
   * `unavailable` means the file or its metadata could not be read at all — the write's landing is
   * unknown. `mismatch` means a different version is on disk — a racing editor save won the window.
   */
  private async verifyWrittenContent(key: string, expected: ArrayBuffer): Promise<
    { matched: true; version: { size: number; mtime: number }; hash: string } | { matched: false; cause: "unavailable" | "mismatch" }
  > {
    const file = this.vault.getFileByPath(key);
    if (!file) return { matched: false, cause: "unavailable" };
    const before = await this.vault.adapter.stat(key);
    if (!before) return { matched: false, cause: "unavailable" };
    let actual: ArrayBuffer;
    try { actual = await this.vault.readBinary(file); } catch { return { matched: false, cause: "unavailable" }; }
    const after = await this.vault.adapter.stat(key);
    // A version that moved while it was being read cannot be attributed to these bytes either.
    if (!after || after.size !== before.size || after.mtime !== before.mtime) return { matched: false, cause: "mismatch" };
    const [expectedHash, actualHash] = await Promise.all([sha256(expected), sha256(actual)]);
    if (expectedHash.value !== actualHash.value) return { matched: false, cause: "mismatch" };
    return { matched: true, version: { size: after.size, mtime: after.mtime }, hash: actualHash.value };
  }

  /**
   * Applies a remote version to the local file, then proves the result before claiming convergence.
   *
   * The baseline may only be committed for bytes the executor has read back and compared with the ones
   * it downloaded. Anything else — a racing editor save, or metadata that cannot be read — is a
   * `partial` with no baseline, so no `local == remote` fact is invented and no merge base is recorded
   * for a version that was never on disk.
   *
   * A write that may have landed is likewise never reported as a definitive `failed`: whether it left
   * a side effect is exactly what is unknown, and the scheduler must not retire a remote generation on
   * the strength of a failure that proves nothing about the local side.
   */
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
    let wrote = false;
    try {
      const file = this.vault.getFileByPath(operation.key);
      if (file) {
        // A throwing write cannot prove that no bytes landed, so it is landing-unknown, not a failure.
        try { await this.vault.modifyBinary(file, bytes); }
        catch (error) { return this.landingUnknown(operation.key, error); }
      } else {
        if (this.vault.getAbstractFileByPath(operation.key) !== null) return { status: "failed", key: operation.key, reason: "target-path-is-folder", error: `Vault path "${operation.key}" is a folder, not a file` };
        // Vault.createBinary does not create missing parent folders, so the chain is made first.
        const folders = await ensureParentFolders(this.vault, operation.key);
        if (!folders.ok) return { status: "failed", key: operation.key, reason: folders.reason, error: folders.error };
        // Creating folders widens the race window, so the target is confirmed once more.
        if (!(await localStillMatches(this.vault, operation.key, operation.expectedLocal))) return { status: "stale", key: operation.key, reason: "local-changed" };
        try { await this.vault.createBinary(operation.key, bytes); }
        catch (error) { return this.landingUnknown(operation.key, error); }
      }
      wrote = true;
      const verified = await this.verifyWrittenContent(operation.key, bytes);
      if (!verified.matched) {
        this.log(`download post-write verification mismatch path-digest=${pathDigest(operation.key)} cause=${verified.cause} result=partial`);
        return {
          status: "partial",
          key: operation.key,
          reason: verified.cause === "unavailable" ? "remote-write-landing-unknown" : "remote-write-raced-with-local-edit",
        };
      }
      const version = { size: verified.version.size, mtime: verified.version.mtime, hash: verified.hash };
      const commit = await this.commit({ key: operation.key, local: version, remote: operation.expectedRemote, syncedAt: Date.now(), remoteIdentity: this.identity, ignorePolicy: this.ignorePolicy });
      if (commit) return commit;
      await this.recordMergeBase(operation.key, { localVersion: { key: operation.key, ...verified.version }, remoteETag: operation.expectedRemote.etag });
      this.log(`download applied path-digest=${pathDigest(operation.key)} etag=${shortEtag(operation.expectedRemote.etag)}`);
      return { status: "applied", key: operation.key, localWrite: { key: operation.key, ...verified.version } };
    } catch (error) {
      // Past the write, a throw says nothing about whether bytes landed: that is landing-unknown, not
      // a definitive failure. Before it, every local side effect is still accounted for.
      if (wrote) return this.landingUnknown(operation.key, error);
      return { status: "failed", key: operation.key, error: message(error) };
    }
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
