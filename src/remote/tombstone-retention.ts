import { RemoteHttpError } from "./errors";
import { pathDigest } from "../sync/path";
import { TOMBSTONE_RETENTION_MS, type RemoteDeletion } from "./tombstones";
import type { R2Client } from "./r2-client";
import type { RemoteEntry } from "../sync/types";

/**
 * Tombstone retention, and the only place deleted content is physically removed from R2.
 *
 * A deletion in this plugin is *logical*: the tombstone is written and the object stays where it is, which
 * is what lets a device that missed the deletion still learn what happened. Left alone that metadata — and
 * the bytes it hides — would accumulate for the life of the vault, so retention eventually retires both.
 * It is deliberately *conservative in both directions*:
 *
 * - it only ever considers records older than {@link TOMBSTONE_RETENTION_MS};
 * - it asks the caller about every candidate, because age alone cannot prove that no device still needs
 *   the record. There is no global acknowledgement and no per-device cursor that says "everyone has seen
 *   this deletion", so the only evidence available is this device's own unfinished business: a conflict it
 *   has not resolved, a decision it has not applied, a file it still holds, a baseline it has not
 *   converged. Anything in that state keeps its record, and therefore its bytes, however old.
 *
 * Removing a record without removing the bytes it hides would be worse than leaving both: the object would
 * become a live remote file again and every device would download the note back. That is why the two are
 * ordered the way they are, and why an object that cannot be proven to be the deleted version blocks the
 * whole cleanup for its path.
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
  /** User objects physically removed. Always a subset of `removed`. */
  objects: number;
}

/** Which half of a deletion was retired, or why nothing was. Kept explicit so each case can be logged. */
type CleanupOutcome = "object-and-record" | "record" | "skipped";

/**
 * Retires one expired, unprotected deletion, bytes first.
 *
 * The object is what has to be reasoned about, because the record alone is metadata: deleting it while the
 * object survives would make the note a live remote file again. So the object is examined first, and only
 * three states allow the record to go with it:
 *
 * - the object is gone — nothing to remove, and the record is now the only trace of why;
 * - the object is a version the record does not name, or one written after the record was accepted — the
 *   path was revived, so this record can never describe the current object again and is dead metadata;
 * - the object is the very version the record names, and has not been written since R2 accepted the
 *   record. That last comparison is the only way to tell a deletion from the same bytes uploaded again
 *   later: an ETag cannot, because it is a digest of the content, so a revival of identical text produces
 *   the same one. Both timestamps come from R2, so no device's clock is trusted.
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

  // The bytes may only go when the object *is* the version the record names and nothing has written it
  // since. The timestamp comparison is the only way to tell a deletion from the same text uploaded again
  // later — an ETag cannot, because it is a digest of the content — and it uses R2's own clock for both
  // sides, so no device's time is trusted.
  const revived = present !== undefined && deletion.metadataLastModified !== undefined && present.lastModified > deletion.metadataLastModified;
  if (present && present.etag === deletedRemoteETag && !revived) {
    if (!client.deleteObject) return "skipped";
    if (deletion.metadataLastModified === undefined) return "skipped";
    try { await client.deleteObject(path); }
    catch { return "skipped"; }
    debug?.(`tombstone cleanup object removed path-digest=${pathDigest(path)} reason=expired`);
    if (!client.deleteTombstone) return "skipped";
    try { await client.deleteTombstone(deletion.tombstone); }
    catch { debug?.(`tombstone cleanup record failed path-digest=${pathDigest(path)}`); return "object-and-record"; }
    return "object-and-record";
  }

  if (!client.deleteTombstone) return "skipped";
  try { await client.deleteTombstone(deletion.tombstone); }
  catch { debug?.(`tombstone cleanup record failed path-digest=${pathDigest(path)}`); return "skipped"; }
  return "record";
}

/**
 * Retires expired tombstones that no local state still depends on, removing the hidden bytes with them.
 *
 * Best-effort by design: this is housekeeping, so one path that cannot be retired must not stop the
 * others. A client without the deletion capabilities makes the whole pass a no-op, which is why they are
 * probed rather than assumed. A failure to list at all is raised, because "we could not even look" is not
 * the same as "nothing needed doing".
 */
export async function pruneExpiredTombstones(client: R2Client, options: TombstoneCleanupOptions): Promise<TombstoneCleanupResult | undefined> {
  if (!client.listTombstones || !client.deleteTombstone) return undefined;
  const tombstones = await client.listTombstones();
  let removed = 0; let objects = 0;
  for (const deletion of expiredTombstones(tombstones, options)) {
    if (options.protect(deletion.tombstone.path)) continue;
    const outcome = await retire(client, deletion, options.debug);
    if (outcome === "skipped") continue;
    removed += 1;
    if (outcome === "object-and-record") objects += 1;
  }
  options.debug?.(`tombstone cleanup removed=${removed} retained=${tombstones.length - removed} objects=${objects}`);
  return { removed, retained: tombstones.length - removed, objects };
}
