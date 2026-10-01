import { RemoteHttpError } from "./errors";
import { pathDigest } from "../sync/path";
import { TOMBSTONE_RETENTION_MS, type RemoteDeletion } from "./tombstones";
import type { R2Client } from "./r2-client";
import type { RemoteEntry } from "../sync/types";

/**
 * Conservative tombstone-history compaction.
 *
 * A deletion in this plugin is *logical*: the tombstone is written and the object stays where it is, which
 * is what lets a device that missed the deletion still learn what happened. Left alone that metadata — and
 * historical records would accumulate for the life of the vault. This pass removes only dead metadata:
 *
 * - it only ever considers records older than {@link TOMBSTONE_RETENTION_MS};
 * - age is only an eligibility filter, never proof of safety;
 * - the current deletion and its hidden object are never removed, because there is no global device ack;
 * - a record is removed only when R2 proves a different or later live object superseded it.
 *
 * Consequently this rule is safe for arbitrarily offline clients, but intentionally does not reclaim
 * bytes hidden by a current deletion. That would require an independent cluster-wide acknowledgement.
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
 * the version identity of a deletion it has not reconciled yet — or, for the bytes, the note itself.
 */
export function protectedFromCleanup(protections: TombstoneProtections, path: string): boolean {
  return protections.ignored(path) || protections.conflicted.has(path) || protections.baselines.has(path) || protections.localFilePresent(path);
}

export interface TombstoneCleanupResult {
  /** Tombstone records removed. */
  removed: number;
  /** Records left behind, whether protected, unexpired, or unprovable. */
  retained: number;
  /** Kept for diagnostics compatibility; this safe compactor always reports zero. */
  objects: number;
}

/** Which half of a deletion was retired, or why nothing was. Kept explicit so each case can be logged. */
type CleanupOutcome = "record" | "skipped";

/**
 * Retires one expired, unprotected historical record.
 *
 * The object is what has to be reasoned about, because the record alone is metadata: deleting it while the
 * object survives would make the note a live remote file again. The record may go only when the object is
 * a version it does not name, or R2's own timestamps prove an identical-ETag object was written later.
 *
 * Anything else — an unreadable object, a missing server timestamp, an object written while the record was
 * being considered — leaves both in place and is simply retried on the next pass.
 */
async function retire(client: R2Client, deletion: RemoteDeletion, debug?: (message: string) => void): Promise<CleanupOutcome> {
  const { path, deletedRemoteETag } = deletion.tombstone;
  let present: RemoteEntry | undefined;
  try { present = await client.headObject(path); }
  catch (error) {
    if (!(error instanceof RemoteHttpError && error.status === 404)) return "skipped";
  }

  const revived = present !== undefined && deletion.metadataLastModified !== undefined && present.lastModified > deletion.metadataLastModified;
  // Age is not a global acknowledgement. The current deleted revision and a missing object therefore
  // keep their record forever; only a different or demonstrably later live object proves history was
  // superseded. Compaction removes metadata only and never user bytes.
  if (!present || present.etag === deletedRemoteETag && !revived) return "skipped";

  if (!client.deleteTombstone) return "skipped";
  try { await client.deleteTombstone(deletion.tombstone); }
  catch { debug?.(`tombstone cleanup record failed path-digest=${pathDigest(path)}`); return "skipped"; }
  return "record";
}

/**
 * Retires expired tombstones that R2 proves have been superseded. User objects are never removed.
 *
 * Best-effort by design: this is housekeeping, so one path that cannot be retired must not stop the
 * others. A client without the deletion capabilities makes the whole pass a no-op, which is why they are
 * probed rather than assumed. A failure to list at all is raised, because "we could not even look" is not
 * the same as "nothing needed doing".
 */
export async function pruneExpiredTombstones(client: R2Client, options: TombstoneCleanupOptions): Promise<TombstoneCleanupResult | undefined> {
  if (!client.listTombstones || !client.deleteTombstone) return undefined;
  const tombstones = await client.listTombstones();
  let removed = 0;
  for (const deletion of expiredTombstones(tombstones, options)) {
    if (options.protect(deletion.tombstone.path)) continue;
    const outcome = await retire(client, deletion, options.debug);
    if (outcome === "skipped") continue;
    removed += 1;
  }
  options.debug?.(`tombstone cleanup removed=${removed} retained=${tombstones.length - removed} objects=0`);
  return { removed, retained: tombstones.length - removed, objects: 0 };
}
