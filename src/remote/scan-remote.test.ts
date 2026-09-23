import { describe, expect, it } from "vitest";
import { scanRemote } from "./scan-remote";
import type { R2Client } from "./r2-client";
import type { VaultPathFilter } from "../sync/ignore";
import { isRemoteDeleted } from "../sync/types";
import { buildSyncPlan } from "../sync/planner";
import type { LocalEntry, PreviousEntry } from "../sync/types";

/**
 * The full-reconcile view of a deletion.
 *
 * This is the recovery path: a Gateway delta can be missed entirely — the app was closed, the socket was
 * down, the device was offline for a week — and the tombstone is what still lets the next full scan learn
 * that a path was *deleted* rather than never having existed. It is also the reason a stale tombstone must
 * never hide a later object: the record names one exact version, and a newer one wins.
 */

const filter: VaultPathFilter = { ignores: () => false } as VaultPathFilter;
const tombstone = (path: string, deletedRemoteETag: string, createdAt = "2026-09-22T00:00:00.000Z") => ({ tombstone: { protocol: 1 as const, path, deletedRemoteETag, createdAt }, metadataETag: `meta-${path}` });

function client(options: { objects?: Array<{ key: string; size: number; etag?: string; lastModified: number }>; tombstones?: ReturnType<typeof tombstone>[] }): { client: R2Client; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      listObjects: async () => { calls.push("listObjects"); return options.objects ?? []; },
      listTombstones: async () => { calls.push("listTombstones"); return options.tombstones ?? []; },
      headObject: async () => { throw new Error("a full scan does not head"); },
      getObject: async () => { throw new Error("a full scan does not read bodies"); },
      putObject: async () => { throw new Error("a full scan does not write"); },
    },
  };
}

describe("a tombstone makes a deletion legible to a full scan", () => {
  it("reports the path as deleted, bound to the exact version it names", async () => {
    const subject = client({ objects: [{ key: "note.md", size: 5, etag: "E", lastModified: 1_000 }], tombstones: [tombstone("note.md", "E")] });

    const remote = await scanRemote(subject.client, filter);

    // A listing and a tombstone listing, and nothing per path: the cost of recovery is known and bounded.
    expect(subject.calls).toEqual(["listObjects", "listTombstones"]);
    expect(remote.get("note.md")).toMatchObject({ key: "note.md", deleted: { path: "note.md", deletedRemoteETag: "E", createdAt: "2026-09-22T00:00:00.000Z", objectPresent: true } });
    expect(isRemoteDeleted(remote.get("note.md"))).toBe(true);
  });

  it("keeps a deletion for a path whose bytes are physically gone", async () => {
    const subject = client({ tombstones: [tombstone("note.md", "E")] });
    const remote = await scanRemote(subject.client, filter);

    expect(remote.get("note.md")).toMatchObject({ size: 0, deleted: { deletedRemoteETag: "E", objectPresent: false } });
  });

  it("never lets an old tombstone hide a later object", async () => {
    // The same bytes uploaded again after the deletion is a new version, not a deleted one.
    const subject = client({ objects: [{ key: "note.md", size: 5, etag: "F", lastModified: 2_000 }], tombstones: [tombstone("note.md", "E")] });
    const remote = await scanRemote(subject.client, filter);

    expect(remote.get("note.md")).toMatchObject({ etag: "F" });
    expect(isRemoteDeleted(remote.get("note.md"))).toBe(false);
  });

  it("leaves an excluded path out of the view entirely", async () => {
    const subject = client({ objects: [{ key: "secret.md", size: 5, etag: "E", lastModified: 1_000 }], tombstones: [tombstone("secret.md", "E")] });
    const remote = await scanRemote(subject.client, { ignores: (key: string) => key.startsWith("secret") } as VaultPathFilter);

    expect(remote.size).toBe(0);
  });
});

/**
 * What the recovery path then decides, which is the whole point of keeping the tombstone.
 *
 * A device that missed the deletion still holds the file. Whether that is a deletion to apply or a
 * conflict to resolve is decided by one question: did the local file change since the recorded baseline.
 */
describe("recovering a deletion that arrived while the device was away", () => {
  const local: LocalEntry = { key: "note.md", size: 5, mtime: 10 };
  const previous: PreviousEntry = { key: "note.md", local: { size: 5, mtime: 10 }, remote: { size: 5, etag: "E" }, syncedAt: 1 };
  const deletedRemote = () => new Map([["note.md", { key: "note.md", size: 0, lastModified: 1_000, deleted: { path: "note.md", deletedRemoteETag: "E", createdAt: "2026-09-22T00:00:00.000Z", objectPresent: true } }]]);

  it("deletes the local file when it still matches the baseline", () => {
    const plan = buildSyncPlan(new Map([["note.md", local]]), deletedRemote(), new Map([["note.md", previous]]));
    expect(plan.operations).toEqual([expect.objectContaining({ type: "delete-local", key: "note.md", expectedLocal: local })]);
  });

  it("asks the user when the local file changed after the baseline", () => {
    const edited: LocalEntry = { key: "note.md", size: 9, mtime: 99 };
    const plan = buildSyncPlan(new Map([["note.md", edited]]), deletedRemote(), new Map([["note.md", previous]]));
    expect(plan.operations).toEqual([expect.objectContaining({ type: "conflict", conflict: "local-modified-remote-deleted" })]);
  });

  it("is a no-op once the deletion has been applied here too", () => {
    // Local gone, remote deleted, baseline retired: the state after a deletion has fully converged.
    const plan = buildSyncPlan(new Map(), deletedRemote(), new Map());
    expect(plan.operations).toEqual([]);
  });

  it("uploads a local file that appeared after the deletion instead of reviving the old version's identity", () => {
    const created: LocalEntry = { key: "note.md", size: 4, mtime: 500 };
    const plan = buildSyncPlan(new Map([["note.md", created]]), deletedRemote(), new Map());
    // There is no baseline for this file, so it is a new local note; the tombstone still names the version
    // it replaced, which is what keeps the write conditional on that version rather than unconditional.
    expect(plan.operations).toEqual([expect.objectContaining({ type: "upload", expectedRemote: { kind: "etag", value: "E" } })]);
  });
});
