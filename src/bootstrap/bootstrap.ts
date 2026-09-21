import { LocalFileChangedError } from "../local/read-local";
import { RemoteObjectChangedError } from "../remote/errors";
import { sha256 } from "../sync/fingerprint";
import { buildSyncPlan } from "../sync/planner";
import type { LocalEntry, PreviousEntry, RemoteEntry, RemoteIdentity, SyncPlan } from "../sync/types";

export interface BootstrapContentReader {
  readLocal(key: string, expected: LocalEntry): Promise<ArrayBuffer>;
  readRemote(key: string, expected: RemoteEntry): Promise<ArrayBuffer>;
}

export interface BootstrapDiagnostics {
  bootstrapCandidates: number;
  verifiedIdentical: number;
  hashedFiles: number;
  hashedBytes: number;
  differentContent: number;
  unresolved: number;
}

export interface BootstrapResult {
  plan: SyncPlan;
  /** The only entries that may be written to IndexedDB during Phase 1.5. */
  baselineCandidates: Map<string, PreviousEntry>;
  diagnostics: BootstrapDiagnostics;
}

const concurrency = 3;
const candidate = (local: LocalEntry | undefined, remote: RemoteEntry | undefined, previous: PreviousEntry | undefined): local is LocalEntry =>
  Boolean(local && remote && local.size === remote.size && (!previous || !previous.local || !previous.remote));

/**
 * Resolves only ambiguous first/partial-baseline pairs. Networking and hashing remain
 * outside the deterministic planner; the planner receives an immutable fact map.
 */
export async function buildBootstrapResult(
  local: Map<string, LocalEntry>,
  remote: Map<string, RemoteEntry>,
  previous: Map<string, PreviousEntry>,
  reader: BootstrapContentReader,
  signal?: AbortSignal,
  remoteIdentity?: RemoteIdentity,
  ignorePolicy?: string,
): Promise<BootstrapResult> {
  const allKeys = [...new Set([...local.keys(), ...remote.keys()])].sort((a, b) => a.localeCompare(b));
  const keys = allKeys.filter((key) => candidate(local.get(key), remote.get(key), previous.get(key)));
  const metadataDifferent = allKeys.filter((key) => {
    const here = local.get(key), there = remote.get(key), before = previous.get(key);
    return Boolean(here && there && here.size !== there.size && (!before || !before.local || !before.remote));
  }).length;
  const baselineCandidates = new Map<string, PreviousEntry>();
  const diagnostics: BootstrapDiagnostics = { bootstrapCandidates: keys.length, verifiedIdentical: 0, hashedFiles: 0, hashedBytes: 0, differentContent: metadataDifferent, unresolved: 0 };
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (!signal?.aborted) {
      const key = keys[cursor++];
      if (!key) return;
      const here = local.get(key)!;
      const there = remote.get(key)!;
      try {
        const [localBytes, remoteBytes] = await Promise.all([reader.readLocal(key, here), reader.readRemote(key, there)]);
        if (signal?.aborted) return;
        diagnostics.hashedFiles += 1;
        diagnostics.hashedBytes += localBytes.byteLength + remoteBytes.byteLength;
        const [localHash, remoteHash] = await Promise.all([sha256(localBytes), sha256(remoteBytes)]);
        if (localHash.value !== remoteHash.value) { diagnostics.differentContent += 1; continue; }
        baselineCandidates.set(key, {
          key,
          local: { size: here.size, mtime: here.mtime, hash: localHash.value },
          remote: { size: there.size, etag: there.etag, lastModified: there.lastModified, hash: remoteHash.value },
          syncedAt: Date.now(),
          remoteIdentity,
          ignorePolicy,
        });
        diagnostics.verifiedIdentical += 1;
      } catch (error) {
        if (error instanceof LocalFileChangedError || error instanceof RemoteObjectChangedError || !signal?.aborted) diagnostics.unresolved += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));
  const plannerPrevious = new Map(previous);
  for (const [key, entry] of baselineCandidates) plannerPrevious.set(key, entry);
  return { plan: buildSyncPlan(local, remote, plannerPrevious), baselineCandidates, diagnostics };
}
