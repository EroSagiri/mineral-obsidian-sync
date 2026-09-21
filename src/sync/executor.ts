import type { Vault } from "obsidian";
import { ensureParentFolders } from "../local/ensure-folders";
import { LocalFileChangedError, readStableLocalBytes } from "../local/read-local";
import { RemoteHttpError, RemoteObjectChangedError } from "../remote/errors";
import type { R2Client } from "../remote/r2-client";
import type { StateStore } from "../state/sync-state";
import type { LocalEntry, PreviousEntry, RemoteIdentity, SyncOperation } from "./types";

/** Precise reasons a Vault write cannot proceed; they are not transport or precondition failures. */
export type VaultWriteFailure = "parent-path-is-file" | "folder-create-failed" | "target-path-is-folder";

export type OperationResult =
  | { status: "applied"; key: string }
  | { status: "stale"; key: string; reason: "local-changed" | "remote-changed" }
  | { status: "blocked"; key: string; reason: "deletion-not-supported-in-phase-2a" | "missing-remote-etag" }
  /** A definitive negative answer: a received 4xx, or a Vault path that cannot hold the write. */
  | { status: "failed"; key: string; error: string; reason?: VaultWriteFailure }
  /** The outcome of the write is genuinely unknown, or the baseline could not be committed. */
  | { status: "unresolved"; key: string; reason: "ambiguous-put" | "state-commit-failed" };

/**
 * A conditional mismatch is a stale plan, not a plugin error. A received 4xx means the write
 * definitely did not happen. Only 5xx/429 responses and transport-level throws leave the
 * outcome of a write genuinely unknown, and those stay fail-safe as `unresolved`.
 */
function uploadFailure(operation: string, key: string, error: unknown): OperationResult {
  if (error instanceof RemoteObjectChangedError) return { status: "stale", key, reason: "remote-changed" };
  if (error instanceof RemoteHttpError) {
    if (error.status < 500 && error.status !== 429) return { status: "failed", key, error: `R2 ${operation} failed with HTTP ${error.status}` };
    return { status: "unresolved", key, reason: "ambiguous-put" };
  }
  // A lost or interrupted response cannot be distinguished from a lost successful response.
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
  constructor(private readonly vault: Vault, private readonly r2: R2Client, private readonly state: StateStore, private readonly identity: RemoteIdentity, private readonly ignorePolicy: string) {}

  async execute(operation: SyncOperation): Promise<OperationResult> {
    if (operation.type === "delete-local" || operation.type === "delete-remote") return { status: "blocked", key: operation.key, reason: "deletion-not-supported-in-phase-2a" };
    if (operation.type !== "upload" && operation.type !== "download") return { status: "failed", key: operation.key, error: `operation ${operation.type} is not executable` };
    return operation.type === "upload" ? this.upload(operation) : this.download(operation);
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
    try { bytes = await this.r2.getObject(operation.key, { ifMatch: operation.expectedRemote.etag }); } catch (error) { return error instanceof RemoteObjectChangedError ? { status: "stale", key: operation.key, reason: "remote-changed" } : { status: "failed", key: operation.key, error: message(error) }; }
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
