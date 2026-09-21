import { localChanged, remoteChanged } from "./fingerprint";
import type { LocalEntry, PreviousEntry, RemoteEntry, SyncOperation, SyncPlan } from "./types";

const operation = (type: SyncOperation["type"], key: string, reason: string, conflict?: Extract<SyncOperation, { type: "conflict" }>["conflict"]): SyncOperation =>
  type === "conflict" ? { type, key, reason, conflict: conflict! } : { type, key, reason } as SyncOperation;

export function buildSyncPlan(local: Map<string, LocalEntry>, remote: Map<string, RemoteEntry>, previous: Map<string, PreviousEntry>): SyncPlan {
  const keys = new Set([...local.keys(), ...remote.keys(), ...previous.keys()]);
  const operations: SyncOperation[] = [];
  for (const key of [...keys].sort((a, b) => a.localeCompare(b))) {
    const here = local.get(key), there = remote.get(key), before = previous.get(key);
    if (!before) {
      if (here && !there) operations.push({ type: "upload", key, reason: "new local file", expectedLocal: here, expectedRemote: { kind: "absent" } });
      else if (!here && there) operations.push({ type: "download", key, reason: "new remote object", expectedLocal: { kind: "absent" }, expectedRemote: there });
      else if (here && there) operations.push(operation("conflict", key, "first sync cannot prove both entries identical", "both-created-different"));
      continue;
    }
    if (here && there) {
      const changedLocal = localChanged(here, before), changedRemote = remoteChanged(there, before);
      if (!changedLocal && !changedRemote) operations.push(operation("noop", key, "unchanged since previous successful sync"));
      else if (changedLocal && !changedRemote) operations.push({ type: "upload", key, reason: "local changed since previous successful sync", expectedLocal: here, expectedRemote: { kind: "etag", value: there.etag } });
      else if (!changedLocal && changedRemote) operations.push({ type: "download", key, reason: "remote changed since previous successful sync", expectedLocal: here, expectedRemote: there });
      else operations.push(operation("conflict", key, "both sides changed since previous successful sync", "both-modified"));
    } else if (!here && !there) {
      operations.push(operation("noop", key, "both sides deleted since previous successful sync"));
    } else if (!here && there) {
      if (remoteChanged(there, before)) operations.push(operation("conflict", key, "local deleted while remote changed", "local-deleted-remote-modified"));
      else operations.push(operation("delete-remote", key, "local deletion since previous successful sync"));
    } else if (here && !there) {
      if (localChanged(here, before)) operations.push(operation("conflict", key, "remote deleted while local changed", "local-modified-remote-deleted"));
      else operations.push(operation("delete-local", key, "remote deletion since previous successful sync"));
    }
  }
  return { operations };
}
