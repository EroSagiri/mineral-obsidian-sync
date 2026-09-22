import type { R2Client } from "./r2-client";
import type { VaultPathFilter } from "../sync/ignore";
import type { RemoteEntry } from "../sync/types";
export type RemoteScanDebugLogger = (message: string) => void;

async function measure<T>(phase: string, work: () => Promise<T>, count: (value: T) => number, debug?: RemoteScanDebugLogger): Promise<T> {
  const startedAt = Date.now();
  try {
    const value = await work();
    debug?.(`cycle remote-scan phase=${phase} entries=${count(value)} durationMs=${Date.now() - startedAt}`);
    return value;
  } catch (error) {
    debug?.(`cycle remote-scan phase=${phase} outcome=error durationMs=${Date.now() - startedAt}`);
    throw error;
  }
}
/**
 * Builds the effective remote view. Tombstones are fetched separately and never materialize as Vault
 * files; an old tombstone only hides the exact object ETag it names.
 */
export async function scanRemote(client: R2Client, filter: VaultPathFilter, debug?: RemoteScanDebugLogger): Promise<Map<string, RemoteEntry>> {
  const [objects, tombstones] = await Promise.all([
    measure("objects-list", () => client.listObjects(), (entries) => entries.length, debug),
    measure("tombstones", () => client.listTombstones ? client.listTombstones() : Promise.resolve([]), (entries) => entries.length, debug),
  ]);
  const output = new Map(objects.filter((entry) => !filter.ignores(entry.key)).map((entry) => [entry.key, entry]));
  for (const deletion of tombstones) {
    const path = deletion.tombstone.path;
    if (filter.ignores(path)) continue;
    const object = output.get(path);
    // A tombstone never hides a later object; it is bound to the exact deleted ETag.
    if (object && object.etag !== deletion.tombstone.deletedRemoteETag) continue;
    output.set(path, {
      key: path,
      size: 0,
      lastModified: Date.parse(deletion.tombstone.createdAt),
      deleted: { path, deletedRemoteETag: deletion.tombstone.deletedRemoteETag, createdAt: deletion.tombstone.createdAt, metadataETag: deletion.metadataETag, objectPresent: Boolean(object) },
    });
  }
  return output;
}
