import { pathDigest } from "../sync/path";
import { TOMBSTONE_RETENTION_MS, type RemoteDeletion } from "./tombstones";
import type { R2Client } from "./r2-client";

/**
 * Tombstone retention.
 *
 * Tombstones are immutable, content-addressed records, one per deleted remote version, and nothing ever
 * removes them on its own — so without a policy the metadata namespace grows for the life of the vault.
 * The cleanup below is deliberately *conservative in both directions*:
 *
 * - it only ever considers records older than {@link TOMBSTONE_RETENTION_MS};
 * - it asks the caller about every candidate, because age alone cannot prove that no device still needs
 *   the record. There is no global acknowledgement and no per-device cursor that says "everyone has
 *   seen this deletion", so the only evidence available is this device's own unfinished business: a
 *   conflict it has not resolved, a decision it has not applied, a file it still holds, a baseline it
 *   has not converged. Anything in that state keeps its tombstone, however old.
 *
 * Removing a tombstone is therefore never a data loss: it retires the metadata that names *which*
 * version was deleted, while the object's absence and the local baseline remain.
 */

export interface TombstoneCleanupOptions {
  now: number;
  /** Overridable only so a test can age a record without waiting. */
  retentionMs?: number;
  /** True when this device still has unfinished business for the path. Such a record is never removed. */
  protect(path: string): boolean;
  debug?(message: string): void;
}

/** The tombstones old enough to be considered, in listing order. Pure, so the policy is testable alone. */
export function expiredTombstones(tombstones: readonly RemoteDeletion[], options: { now: number; retentionMs?: number }): RemoteDeletion[] {
  const retentionMs = options.retentionMs ?? TOMBSTONE_RETENTION_MS;
  return tombstones.filter((deletion) => {
    const createdAt = Date.parse(deletion.tombstone.createdAt);
    // A record whose creation time cannot be read is kept: an unreadable age is not an old age.
    return Number.isFinite(createdAt) && createdAt < options.now - retentionMs;
  });
}

/** What this device still has to do with a path, as far as retention is concerned. */
export interface TombstoneProtections {
  /** Paths with an active conflict record. A pending decision lives only against a detected conflict. */
  conflicted: ReadonlySet<string>;
  /** Paths whose baseline has not converged on the absence yet. */
  baselines: ReadonlySet<string>;
  ignored(key: string): boolean;
  localFilePresent(key: string): boolean;
}

/**
 * Whether a path's deletion record must survive cleanup, however old.
 *
 * Every branch is evidence of unfinished business, and the whole list is deliberately on the
 * conservative side: a wrong "protect" costs one stale metadata record, a wrong "remove" costs a device
 * the version identity of a deletion it has not reconciled yet.
 */
export function protectedFromCleanup(protections: TombstoneProtections, path: string): boolean {
  return protections.ignored(path) || protections.conflicted.has(path) || protections.baselines.has(path) || protections.localFilePresent(path);
}

/**
 * Removes expired tombstones that no local state still depends on.
 *
 * Best-effort by design: this is metadata housekeeping, so one record that cannot be removed must not
 * stop the others. A client without tombstone deletion makes the whole pass a no-op, which is why the
 * capability is probed rather than assumed. The returned counts are what the caller logs; a failure to
 * list at all is raised, because "we could not even look" is not the same as "nothing was old enough".
 */
export async function pruneExpiredTombstones(client: R2Client, options: TombstoneCleanupOptions): Promise<{ removed: number; retained: number } | undefined> {
  if (!client.listTombstones || !client.deleteObject) return undefined;
  const tombstones = await client.listTombstones();
  let removed = 0;
  for (const deletion of expiredTombstones(tombstones, options)) {
    if (options.protect(deletion.tombstone.path)) continue;
    try { await client.deleteObject(deletion.tombstone); removed += 1; }
    catch { options.debug?.(`tombstone cleanup failed path-digest=${pathDigest(deletion.tombstone.path)}`); }
  }
  options.debug?.(`tombstone cleanup removed=${removed} retained=${tombstones.length - removed}`);
  return { removed, retained: tombstones.length - removed };
}
