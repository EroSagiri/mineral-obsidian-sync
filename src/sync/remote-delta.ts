import type { RemoteChange } from "@mineral/sync-core/sync-change";
import { RemoteHttpError } from "../remote/errors";
import type { R2Client } from "../remote/r2-client";
import { parseTombstone, tombstoneKey } from "../remote/tombstones";
import { canonicalKey } from "./path";
import type { LocalEntry, PreviousEntry, RemoteDeletionIdentity, RemoteEntry } from "./types";

/**
 * Turning a Gateway delta into the exact-path observations the planner consumes.
 *
 * This is the whole point of the control plane: a `put` or a `delete` for one path must be answerable
 * without listing the bucket, because a LIST is the cost that incremental sync exists to avoid. What a
 * change event does *not* carry, it is filled in by one exact request for that one path — never by a
 * guess from wall-clock time, and never by a listing.
 *
 * The one subtlety is deletion. The event says *that* a path was deleted; the planner needs to know
 * *which version* it was, because that is what a resolution is bound to and what a later revive is
 * planned against. One HEAD answers it: this plugin deletes by writing an immutable tombstone and
 * leaving the object where it is, so the deleted version is normally still readable at its exact ETag.
 *
 * A deletion observed this way must be shaped *exactly* like one observed by a full scan — same fields,
 * no live-object ETag on it — because the conflict identity is derived from those fields. Anything extra
 * here would give the same disagreement two identities depending on how it was noticed, and a user's
 * pending decision would stop matching the moment the observation mode changed.
 */

export interface RemoteDeltaDependencies {
  client: R2Client;
  /** The same ignore policy the full scan applies, so a delta can never reach a path a scan would skip. */
  ignores(key: string): boolean;
  loadPrevious(): Promise<Map<string, PreviousEntry>>;
  statLocal(key: string): Promise<{ size: number; mtime: number } | null>;
  /** Whether a baseline entry is usable in the namespace currently in force. */
  acceptsBaseline(key: string, entry: PreviousEntry): boolean;
}

export interface RemoteDeltaObservations {
  local: Map<string, LocalEntry>;
  remote: Map<string, RemoteEntry>;
  previous: Map<string, PreviousEntry>;
}

/**
 * Whether the exact version still reachable at a path has been logically deleted.
 *
 * A tombstone's key is a digest of the path *and* the deleted version, so the record can be looked up
 * directly once the object's own ETag is known — no listing, no guessing at which version the deletion
 * named. A record that names something else is a hard metadata error rather than evidence: it would mean
 * the key and its content disagree, which is not a state any decision may be based on.
 */
export async function findLogicallyDeleted(client: R2Client, key: string, etag: string): Promise<RemoteDeletionIdentity | undefined> {
  let body: ArrayBuffer;
  try { body = await client.getObject(await tombstoneKey(key, etag)); }
  catch (error) { if (error instanceof RemoteHttpError && error.status === 404) return undefined; throw error; }
  const record = parseTombstone(body);
  if (record.path !== key || record.deletedRemoteETag !== etag) throw new Error("Tombstone does not describe the object it was looked up for");
  return { path: key, deletedRemoteETag: etag, createdAt: record.createdAt, objectPresent: true };
}

/**
 * The exact-path observations for keys this device reported as changed locally.
 *
 * One HEAD per key answers create, modify and delete alike, and the remote is never listed: the local
 * side already said which paths to look at.
 *
 * The subtle case is a path whose local file is gone while the object is still there. That is either a
 * deletion to propagate, or the same deletion arriving a second time — and the second reading is the one
 * that must not be mistaken for a new remote file, because downloading it would resurrect a note the
 * user deleted. A tombstone for exactly this version settles it; it is only looked up when there is no
 * baseline left to say what happened, which is the only situation where the two are indistinguishable.
 */
export async function observeLocalDelta(keys: readonly string[], dependencies: RemoteDeltaDependencies): Promise<RemoteDeltaObservations> {
  const local = new Map<string, LocalEntry>();
  const remote = new Map<string, RemoteEntry>();
  // Read the baseline store once: whether a deletion has already been accounted for is a property of the
  // whole observation, not of the one request that happens to be in flight.
  const all = await dependencies.loadPrevious();

  for (const key of keys) {
    if (dependencies.ignores(key)) continue;
    const stat = await dependencies.statLocal(key);
    if (stat) local.set(key, { key, size: stat.size, mtime: stat.mtime });
    let present: RemoteEntry | undefined;
    try { present = await dependencies.client.headObject(key); }
    catch (error) { if (!(error instanceof RemoteHttpError && error.status === 404)) throw error; }
    if (!present) continue;
    const baseline = all.get(key);
    if (!local.has(key) && present.etag !== undefined && (baseline === undefined || !dependencies.acceptsBaseline(key, baseline))) {
      // Local gone, object present, nothing recorded about this path: the one shape where a repeated
      // local deletion and a brand-new remote file look identical. The tombstone is what tells them apart.
      const deleted = await findLogicallyDeleted(dependencies.client, key, present.etag);
      if (deleted) { remote.set(key, deletedObservation(key, present.etag, present.lastModified, baseline?.remote?.lastModified)); continue; }
    }
    remote.set(key, present);
  }
  return { local, remote, previous: usableBaselines(keys, all, dependencies) };
}

/** Every key a delta touches, canonicalised, so one path cannot be observed twice under two spellings. */
function deltaKeys(changes: readonly RemoteChange[]): string[] {
  const keys = new Set<string>();
  for (const change of changes) {
    if (change.op === "rename") { keys.add(canonicalKey(change.from)); keys.add(canonicalKey(change.to)); }
    else keys.add(canonicalKey(change.path));
  }
  return [...keys];
}

/**
 * The baselines that describe exactly the changed paths, under the namespace and ignore policy in force.
 *
 * A delta is answered for a handful of keys, so this is a filter rather than a query: what matters is that
 * a baseline from another namespace, or one invalidated by an ignore-policy change, can never be used to
 * decide anything about these paths.
 */
function usableBaselines(keys: readonly string[], all: Map<string, PreviousEntry>, dependencies: RemoteDeltaDependencies): Map<string, PreviousEntry> {
  const previous = new Map<string, PreviousEntry>();
  for (const [key, entry] of all) {
    if (!keys.includes(key) || dependencies.ignores(key)) continue;
    if (dependencies.acceptsBaseline(key, entry)) previous.set(key, entry);
  }
  return previous;
}

/**
 * The exact observation a deleted path produces, in the one shape both observation modes must agree on.
 *
 * It mirrors what `scanRemote` builds from a tombstone: the deletion identity and nothing that describes
 * a live object. An ETag or size from the still-present object would be a fact about the version that was
 * deleted, not about a remote version that exists now, and leaving it on the entry would silently change
 * the conflict identity derived from it.
 *
 * A HEAD that reports no ETag cannot name a version, and a version is what a deletion identity means; that
 * case is therefore observed as an absent remote. The planner then plans against absence, which is safe in
 * every branch, instead of against a version nobody can check.
 */
function deletedObservation(key: string, objectETag: string | undefined, objectModified: number | undefined, baselineModified: number | undefined): RemoteEntry {
  return objectETag === undefined
    ? { key, size: 0, lastModified: baselineModified ?? objectModified ?? 0, deleted: { path: key, deletedRemoteETag: "", objectPresent: false } }
    : { key, size: 0, lastModified: objectModified ?? baselineModified ?? 0, deleted: { path: key, deletedRemoteETag: objectETag, objectPresent: true } };
}

export async function observeRemoteDelta(changes: readonly RemoteChange[], dependencies: RemoteDeltaDependencies): Promise<RemoteDeltaObservations> {
  const keys = deltaKeys(changes);
  const remote = new Map<string, RemoteEntry>();
  // Read the baseline store once, before any per-path request: a deletion is measured against the
  // baseline for its path, and loading the store per deleted path would turn one delta into N reads.
  const all = await dependencies.loadPrevious();

  for (const change of changes) {
    if (change.op === "rename") {
      // A rename is still two facts for two paths, and each is decided on its own. The removed side
      // carries no version identity, exactly like a delete whose object is already gone.
      remote.delete(canonicalKey(change.from));
      const key = canonicalKey(change.to);
      if (!dependencies.ignores(key)) remote.set(key, await dependencies.client.headObject(key, change.etag ? { ifMatch: change.etag } : {}));
      continue;
    }
    const key = canonicalKey(change.path);
    if (dependencies.ignores(key)) continue;
    if (change.op === "delete") {
      let present: RemoteEntry | undefined;
      try { present = await dependencies.client.headObject(key); }
      catch (error) { if (!(error instanceof RemoteHttpError && error.status === 404)) throw error; }
      remote.set(key, deletedObservation(key, present?.etag, present?.lastModified, all.get(key)?.remote?.lastModified));
      continue;
    }
    // A complete put fact avoids another request. Any omitted field is filled by one exact HEAD, and
    // the event's ETag is still asserted when it supplied one, so a stale event cannot be recorded.
    const modified = change.modified ? Date.parse(change.modified) : NaN;
    if (change.etag && typeof change.size === "number" && Number.isFinite(modified)) remote.set(key, { key, etag: change.etag, size: change.size, lastModified: modified });
    else remote.set(key, await dependencies.client.headObject(key, change.etag ? { ifMatch: change.etag } : {}));
  }

  const local = new Map<string, LocalEntry>();
  for (const key of keys) {
    if (dependencies.ignores(key)) continue;
    const stat = await dependencies.statLocal(key);
    if (stat) local.set(key, { key, size: stat.size, mtime: stat.mtime });
  }
  return { local, remote, previous: usableBaselines(keys, all, dependencies) };
}
