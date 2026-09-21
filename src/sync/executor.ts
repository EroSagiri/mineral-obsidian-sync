import type { Vault } from "obsidian";
import { LocalFileChangedError, readStableLocalBytes } from "../local/read-local";
import { RemoteObjectChangedError } from "../remote/errors";
import type { R2Client } from "../remote/r2-client";
import type { StateStore } from "../state/sync-state";
import type { LocalEntry, PreviousEntry, RemoteIdentity, SyncOperation } from "./types";

export type OperationResult =
  | { status: "applied"; key: string }
  | { status: "stale"; key: string; reason: "local-changed" | "remote-changed" }
  | { status: "blocked"; key: string; reason: "deletion-not-supported-in-phase-2a" | "missing-remote-etag" }
  | { status: "failed"; key: string; error: string }
  | { status: "unresolved"; key: string; reason: "ambiguous-put" | "state-commit-failed" };

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
      if (error instanceof RemoteObjectChangedError) return { status: "stale", key: operation.key, reason: "remote-changed" };
      // A transport failure after PUT is not safely distinguishable from a lost successful response.
      return { status: "unresolved", key: operation.key, reason: "ambiguous-put" };
    }
  }
  private async download(operation: Extract<SyncOperation, { type: "download" }>): Promise<OperationResult> {
    if (!operation.expectedRemote.etag) return { status: "blocked", key: operation.key, reason: "missing-remote-etag" };
    if (!(await localStillMatches(this.vault, operation.key, operation.expectedLocal))) return { status: "stale", key: operation.key, reason: "local-changed" };
    let bytes: ArrayBuffer;
    try { bytes = await this.r2.getObject(operation.key, { ifMatch: operation.expectedRemote.etag }); } catch (error) { return error instanceof RemoteObjectChangedError ? { status: "stale", key: operation.key, reason: "remote-changed" } : { status: "failed", key: operation.key, error: message(error) }; }
    if (!(await localStillMatches(this.vault, operation.key, operation.expectedLocal))) return { status: "stale", key: operation.key, reason: "local-changed" };
    try {
      const file = this.vault.getFileByPath(operation.key);
      if (file) await this.vault.modifyBinary(file, bytes); else await this.vault.createBinary(operation.key, bytes);
      const local = await this.vault.adapter.stat(operation.key);
      if (!local) return { status: "failed", key: operation.key, error: "Vault write did not produce a file" };
      const commit = await this.commit({ key: operation.key, local: { size: local.size, mtime: local.mtime }, remote: operation.expectedRemote, syncedAt: Date.now(), remoteIdentity: this.identity, ignorePolicy: this.ignorePolicy });
      return commit ?? { status: "applied", key: operation.key };
    } catch (error) { return { status: "failed", key: operation.key, error: message(error) }; }
  }
}
