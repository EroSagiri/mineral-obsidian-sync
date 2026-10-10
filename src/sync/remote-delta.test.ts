import { describe, expect, it } from "vitest";
import type { RemoteChange } from "@mineral/sync-core/sync-change";
import { RemoteHttpError } from "../remote/errors";
import type { R2Client } from "../remote/r2-client";
import { TOMBSTONE_PROTOCOL, encodeTombstone, tombstoneKey, type RemoteTombstone } from "../remote/tombstones";
import { observeLocalDelta, observeRemoteDelta } from "./remote-delta";
import type { PreviousEntry, RemoteEntry } from "./types";

/**
 * The exact-path delta path.
 *
 * What is being pinned here is not only the observations but the *requests*: a Gateway delta exists to
 * avoid a bucket listing, so a delete that grows a ListObjectsV2 or a ListTombstonesV2 would defeat the
 * whole control plane. Every test therefore drives a client that records what it was asked for, and the
 * listings are not implemented at all — attempting one is a type error here and a failure in practice.
 */

type Calls = string[];

function client(options: { head?: (key: string) => Promise<RemoteEntry>; calls: Calls }): R2Client {
  return {
    listObjects: async () => { options.calls.push("listObjects"); throw new Error("a delta must never list objects"); },
    listTombstones: async () => { options.calls.push("listTombstones"); throw new Error("a delta must never list tombstones"); },
    headObject: async (key: string) => { options.calls.push(`head:${key}`); return options.head ? options.head(key) : { key, size: 3, etag: "E", lastModified: 1_000 }; },
    getObject: async () => { options.calls.push("getObject"); throw new Error("a delta must never read an object body"); },
    putObject: async () => { options.calls.push("putObject"); throw new Error("a delta never writes"); },
  };
}

const previous = (key: string, etag = "E"): PreviousEntry => ({ key, local: { size: 3, mtime: 10 }, remote: { size: 3, etag, lastModified: 900 }, syncedAt: 500 });

function dependencies(calls: Calls, options: { head?: (key: string) => Promise<RemoteEntry>; local?: Map<string, { size: number; mtime: number }>; stored?: Map<string, PreviousEntry> } = {}) {
  return {
    client: client({ head: options.head, calls }),
    ignores: () => false,
    loadPrevious: async () => options.stored ?? new Map([[  "foo.md", previous("foo.md")]]),
    statLocal: async (key: string) => options.local?.get(key) ?? null,
    acceptsBaseline: () => true,
  };
}

describe("a Gateway delete is answered with one HEAD", () => {
  it("names the deleted version from the object that is still there", async () => {
    const calls: Calls = [];
    const changes: RemoteChange[] = [{ op: "delete", path: "foo.md" }];

    const observed = await observeRemoteDelta(changes, dependencies(calls));

    // One exact request for the one path, and no listing of any kind.
    expect(calls).toEqual(["head:foo.md"]);
    // The tombstone is written without removing the object, so the deleted version is the object's own
    // ETag — and it lives *only* in the deletion identity. Nothing that describes a live object is left
    // on the entry, because a full scan produces exactly these fields and the conflict identity is
    // derived from them: an extra ETag here would give one disagreement two identities.
    const observedEntry = observed.remote.get("foo.md")!;
    expect(observedEntry).toMatchObject({ key: "foo.md", deleted: { path: "foo.md", deletedRemoteETag: "E", objectPresent: true } });
    expect(observedEntry.etag).toBeUndefined();
    expect(observedEntry.deleted && "etag" in observedEntry.deleted).toBe(false);
    expect(observed.previous.get("foo.md")).toMatchObject({ key: "foo.md", remote: { etag: "E" } });
    expect(observed.local.size).toBe(0);
  });

  it("reads the local file as well when this device still has it", async () => {
    const calls: Calls = [];
    const observed = await observeRemoteDelta([{ op: "delete", path: "foo.md" }], dependencies(calls, { local: new Map([["foo.md", { size: 9, mtime: 42 }]]) }));

    expect(calls).toEqual(["head:foo.md"]);
    expect(observed.local.get("foo.md")).toEqual({ key: "foo.md", size: 9, mtime: 42 });
  });

  it("reports an unnamed deletion when the bytes are physically gone", async () => {
    const calls: Calls = [];
    const observed = await observeRemoteDelta([{ op: "delete", path: "foo.md" }], dependencies(calls, {
      head: async (key) => { throw new RemoteHttpError("HeadObject", 404); },
      stored: new Map([["foo.md", { ...previous("foo.md"), remote: { size: 3, etag: "E", lastModified: 777 } }]]),
    }));

    // Nothing can name a version that is not there, so the deletion is observed as an absent remote. It
    // is never given an invented ETag, and the baseline's own timestamp is carried through rather than
    // papering over the gap with the local clock.
    expect(observed.remote.get("foo.md")).toMatchObject({ size: 0, lastModified: 777, deleted: { path: "foo.md", deletedRemoteETag: "", objectPresent: false } });
  });

  it("does not ask about a path the ignore policy excludes", async () => {
    const calls: Calls = [];
    const observed = await observeRemoteDelta([{ op: "delete", path: "foo.md" }], { ...dependencies(calls), ignores: (key) => key === "foo.md" });

    expect(calls).toEqual([]);
    expect(observed.remote.size).toBe(0);
    expect(observed.previous.size).toBe(0);
  });

  it("lets a transport failure through instead of inventing a deletion", async () => {
    const calls: Calls = [];
    await expect(observeRemoteDelta([{ op: "delete", path: "foo.md" }], dependencies(calls, {
      head: async () => { throw new RemoteHttpError("HeadObject", 503); },
    }))).rejects.toThrow();
  });
});

describe("put and rename deltas keep their exact-path shape", () => {
  it("takes a complete put fact without any request at all", async () => {
    const calls: Calls = [];
    const observed = await observeRemoteDelta([{ op: "put", path: "foo.md", etag: "N", size: 5, modified: "2026-09-22T00:00:00.000Z" }], dependencies(calls));

    expect(calls).toEqual([]);
    expect(observed.remote.get("foo.md")).toMatchObject({ etag: "N", size: 5, lastModified: Date.parse("2026-09-22T00:00:00.000Z") });
  });

  it("heads an incomplete put fact, and asserts the ETag the event claimed", async () => {
    const calls: Calls = [];
    const observed = await observeRemoteDelta([{ op: "put", path: "foo.md", etag: "N" }], dependencies(calls));

    expect(calls).toEqual(["head:foo.md"]);
    expect(observed.remote.get("foo.md")).toMatchObject({ etag: "E" });
  });

  it("treats both halves of a rename as their own exact path", async () => {
    const calls: Calls = [];
    const observed = await observeRemoteDelta([{ op: "rename", from: "old.md", to: "new.md" }], dependencies(calls));

    expect(calls).toEqual(["head:new.md"]);
    // The removed side carries no identity, exactly like a deletion whose object is gone.
    expect(observed.remote.has("old.md")).toBe(false);
    expect(observed.remote.get("new.md")).toMatchObject({ key: "new.md" });
  });
});

describe("a delta observes only the paths it names", () => {
  it("filters the baseline to those paths and keeps the namespace rules", async () => {
    const calls: Calls = [];
    const stored = new Map([["foo.md", previous("foo.md")], ["other.md", previous("other.md")]]);
    const observed = await observeRemoteDelta([{ op: "put", path: "foo.md", etag: "N", size: 5, modified: "2026-09-22T00:00:00.000Z" }], dependencies(calls, { stored }));

    expect([...observed.previous.keys()]).toEqual(["foo.md"]);
    // A baseline for a path outside the delta is never touched, and never even loaded twice.
    expect(observed.local.size).toBe(0);
  });

  it("drops a baseline the current namespace does not accept", async () => {
    const calls: Calls = [];
    const observed = await observeRemoteDelta([{ op: "delete", path: "foo.md" }], { ...dependencies(calls), acceptsBaseline: () => false });

    expect(observed.previous.size).toBe(0);
    // The observation itself is unaffected: a decision never depends on a baseline being usable.
    expect(observed.remote.get("foo.md")).toMatchObject({ deleted: { objectPresent: true } });
  });
});

/**
 * The local half of the same idea.
 *
 * A local change already names its path, so one HEAD is again the whole remote answer. The case worth
 * pinning is a path whose local file is gone while the object is still there: that is either a deletion
 * to propagate or the same deletion arriving again, and treating the second as a new remote file would
 * download a note the user deleted straight back into the vault.
 */
describe("a locally-changed path is answered with one HEAD", () => {
  const TOMBSTONE: RemoteTombstone = { protocol: TOMBSTONE_PROTOCOL, path: "foo.md", deletedRemoteETag: "E", createdAt: "2026-09-22T00:00:00.000Z" };
  /** A client that serves the exact tombstone for (foo.md, E) and nothing else. */
  async function withTombstone(calls: Calls): Promise<R2Client> {
    const key = await tombstoneKey(TOMBSTONE.path, TOMBSTONE.deletedRemoteETag);
    return {
      listObjects: async () => { calls.push("listObjects"); throw new Error("a local delta must never list"); },
      listTombstones: async () => { calls.push("listTombstones"); throw new Error("a local delta must never list"); },
      headObject: async (path: string) => { calls.push(`head:${path}`); return { key: path, size: 3, etag: "E", lastModified: 1_000 }; },
      getObject: async (requested: string) => {
        calls.push(`get:${requested === key ? "tombstone" : "other"}`);
        if (requested !== key) throw new RemoteHttpError("GetObject", 404);
        return encodeTombstone(TOMBSTONE);
      },
      putObject: async () => { calls.push("putObject"); throw new Error("a delta never writes"); },
    };
  }

  const localDependencies = (calls: Calls, client: R2Client, options: { local?: Map<string, { size: number; mtime: number }>; stored?: Map<string, PreviousEntry> } = {}) => ({
    client,
    ignores: () => false,
    loadPrevious: async () => options.stored ?? new Map<string, PreviousEntry>(),
    statLocal: async (key: string) => options.local?.get(key) ?? null,
    acceptsBaseline: () => true,
  });

  it("propagates a local deletion as a live object the planner can delete", async () => {
    const calls: Calls = [];
    const client = await withTombstone(calls);

    // The file is gone locally and the baseline says what was synced, so this is a deletion to propagate.
    // The tombstone is not even consulted: a baseline already answers the question.
    const observed = await observeLocalDelta(["foo.md"], localDependencies(calls, client, { stored: new Map([["foo.md", previous("foo.md")]]) }));
    expect(calls).toEqual(["head:foo.md"]);
    expect(observed.remote.get("foo.md")).toMatchObject({ etag: "E" });
    expect(observed.remote.get("foo.md")?.deleted).toBeUndefined();
  });

  it("recognizes the same deletion arriving twice instead of resurrecting the note", async () => {
    const calls: Calls = [];
    const client = await withTombstone(calls);

    // No baseline: the deletion already landed here and was accounted for, which is exactly why the
    // object that is still physically present must not be read as a new remote file.
    const observed = await observeLocalDelta(["foo.md"], localDependencies(calls, client));

    expect(calls).toEqual(["head:foo.md", "get:tombstone"]);
    expect(observed.remote.get("foo.md")).toMatchObject({ key: "foo.md", deleted: { path: "foo.md", deletedRemoteETag: "E", objectPresent: true } });
  });

  it("treats an object with no tombstone as a genuine remote file", async () => {
    const calls: Calls = [];
    const client = await withTombstone(calls);
    const withoutTombstone: R2Client = { ...client, getObject: async () => { calls.push("get:missing"); throw new RemoteHttpError("GetObject", 404); } };

    const observed = await observeLocalDelta(["foo.md"], localDependencies(calls, withoutTombstone));

    expect(calls).toEqual(["head:foo.md", "get:missing"]);
    expect(observed.remote.get("foo.md")?.deleted).toBeUndefined();
  });

  it("never asks about a tombstone while the local file is still here", async () => {
    const calls: Calls = [];
    const client = await withTombstone(calls);

    // A modify is never ambiguous: the file exists, so the object is simply the current remote version.
    const observed = await observeLocalDelta(["foo.md"], localDependencies(calls, client, { local: new Map([["foo.md", { size: 9, mtime: 42 }]]) }));

    expect(calls).toEqual(["head:foo.md"]);
    expect(observed.local.get("foo.md")).toEqual({ key: "foo.md", size: 9, mtime: 42 });
  });

  it("reports an object that is gone as nothing at all", async () => {
    const calls: Calls = [];
    const client = await withTombstone(calls);
    const absent: R2Client = { ...client, headObject: async (path: string) => { calls.push(`head:${path}`); throw new RemoteHttpError("HeadObject", 404); } };

    const observed = await observeLocalDelta(["foo.md"], localDependencies(calls, absent, { local: new Map([["foo.md", { size: 9, mtime: 42 }]]) }));

    expect(calls).toEqual(["head:foo.md"]);
    expect(observed.remote.size).toBe(0);
    expect(observed.local.size).toBe(1);
  });

  it("never asks about a path the ignore policy excludes", async () => {
    const calls: Calls = [];
    const client = await withTombstone(calls);
    const observed = await observeLocalDelta(["foo.md"], { ...localDependencies(calls, client), ignores: () => true });

    expect(calls).toEqual([]);
    expect(observed.local.size).toBe(0);
    expect(observed.remote.size).toBe(0);
  });
});
