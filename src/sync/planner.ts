import { localChanged, remoteChanged } from "./fingerprint";
import type { LocalEntry, PreviousEntry, RemoteEntry, SyncOperation, SyncPlan } from "./types";

/**
 * The planner's view of a pending resolution.
 *
 * It is a plain value, not a store handle: the planner stays a pure function, so it must be handed
 * everything it needs to decide. The orchestrator computes the current conflict identity and looks up
 * any intent bound to it, which keeps all I/O out of this file.
 *
 * `intent` is only supplied when the intent's bound conflict identity **equals** the identity derived
 * from the observations in this very plan. That is the guarantee that a resolution authored against
 * one pair of versions can never be applied to another.
 */
export interface ResolutionProposal {
  intent: {
    conflictId: string;
    type: "keep-local" | "keep-remote" | "merged";
    merged?: { content: string; sha256: string; encoding: { bom: boolean; eol: "lf" | "crlf" | "mixed"; trailingNewline: boolean } };
  };
}

const operation = (type: SyncOperation["type"], key: string, reason: string, conflict?: Extract<SyncOperation, { type: "conflict" }>["conflict"]): SyncOperation =>
  type === "conflict" ? { type, key, reason, conflict: conflict! } : { type, key, reason } as SyncOperation;

/**
 * Emits the resolution operation for a conflicted key when — and only when — a still-valid intent
 * exists for the exact conflict identity observed now.
 *
 * A stale intent is simply ignored here. It is never "upgraded" into a transfer, and the conflict is
 * reported as a conflict instead, which is what forces the user to look at the new versions.
 */
function resolutionOperation(candidate: ResolutionProposal | undefined, key: string, here: LocalEntry, there: RemoteEntry): SyncOperation | undefined {
  if (!candidate) return undefined;
  const base = { key, conflictId: candidate.intent.conflictId, expectedLocal: here, expectedRemoteETag: there.etag, reason: `user resolution (${candidate.intent.type}) for the observed conflict` } as const;
  if (candidate.intent.type === "keep-local") return { type: "resolve-keep-local", ...base };
  if (candidate.intent.type === "keep-remote") return { type: "resolve-keep-remote", ...base };
  if (!candidate.intent.merged) return undefined;
  return { type: "resolve-merged", ...base, merged: candidate.intent.merged };
}

export function buildSyncPlan(
  local: Map<string, LocalEntry>,
  remote: Map<string, RemoteEntry>,
  previous: Map<string, PreviousEntry>,
  resolutions?: Map<string, ResolutionProposal>,
): SyncPlan {
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
      else operations.push(resolutionOperation(resolutions?.get(key), key, here, there) ?? operation("conflict", key, "both sides changed since previous successful sync", "both-modified"));
    } else if (!here && !there) {
      // Both sides are gone, so this baseline describes nothing that exists. Keeping it would leave
      // a permanent, unresolvable key in every future plan; forgetting it touches no user data.
      operations.push({ type: "prune-baseline", key, reason: "absent locally and remotely since the previous successful sync" });
    } else if (!here && there) {
      if (remoteChanged(there, before)) operations.push(operation("conflict", key, "local deleted while remote changed", "local-deleted-remote-modified"));
      else operations.push({ type: "delete-remote", key, reason: "local deletion since previous successful sync" });
    } else if (here && !there) {
      if (localChanged(here, before)) operations.push(operation("conflict", key, "remote deleted while local changed", "local-modified-remote-deleted"));
      // The remote is gone and the local file still provably matches the recorded baseline, so the
      // deletion is propagating a remote removal rather than discarding an unsynced local edit.
      else operations.push({ type: "delete-local", key, reason: "remote deletion since previous successful sync", expectedLocal: here });
    }
  }
  return { operations };
}
