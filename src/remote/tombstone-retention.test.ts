import { describe, expect, it } from "vitest";
import { RemoteHttpError } from "./errors";
import type { R2Client } from "./r2-client";
import { protectedFromCleanup, pruneExpiredTombstones, expiredTombstones } from "./tombstone-retention";
import { TOMBSTONE_RETENTION_MS, type RemoteDeletion } from "./tombstones";

/**
 * Tombstone retention.
 *
 * The policy has two halves and both are safety-critical in opposite directions: an expired record that
 * is removed too eagerly costs an offline device the version identity of a deletion, and one that is
 * never removed grows the metadata namespace forever. These tests pin the boundary and the protections
 * that override it.
 */

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
/** The record was accepted by R2 one day ago, and the object it names was written a day before that. */
const RECORD_ACCEPTED_AT = NOW - 24 * 60 * 60 * 1000;
const deletion = (path: string, createdAt: string, metadataLastModified = RECORD_ACCEPTED_AT): RemoteDeletion => ({
  tombstone: { protocol: 1, path, deletedRemoteETag: `etag-${path}`, createdAt },
  metadataETag: `meta-${path}`,
  metadataLastModified,
});

describe("what counts as expired", () => {
  it("keeps a record that has not reached the window", () => {
    const fresh = deletion("fresh.md", ago(TOMBSTONE_RETENTION_MS - 1));
    expect(expiredTombstones([fresh], { now: NOW })).toEqual([]);
  });

  it("keeps a record sitting exactly on the boundary", () => {
    // Strictly older than the window expires; the boundary itself is still inside it.
    expect(expiredTombstones([deletion("edge.md", ago(TOMBSTONE_RETENTION_MS))], { now: NOW })).toEqual([]);
  });

  it("expires a record past the window", () => {
    const old = deletion("old.md", ago(TOMBSTONE_RETENTION_MS + 1));
    expect(expiredTombstones([old], { now: NOW })).toEqual([old]);
  });

  it("keeps a record whose age cannot be read", () => {
    // An unreadable creation time is not an old creation time.
    expect(expiredTombstones([deletion("broken.md", "not a date")], { now: NOW })).toEqual([]);
  });
});

describe("what protects a record from cleanup", () => {
  const protections = (overrides: Partial<Parameters<typeof protectedFromCleanup>[0]> = {}) => ({
    conflicted: new Set<string>(),
    baselines: new Set<string>(),
    ignored: () => false,
    localFilePresent: () => false,
    ...overrides,
  });

  it("protects nothing it has no evidence about", () => {
    expect(protectedFromCleanup(protections(), "gone.md")).toBe(false);
  });

  it("protects unfinished business, an unconverged baseline, a file, and an ignored path", () => {
    expect(protectedFromCleanup(protections({ conflicted: new Set(["a.md"]) }), "a.md")).toBe(true);
    expect(protectedFromCleanup(protections({ baselines: new Set(["b.md"]) }), "b.md")).toBe(true);
    expect(protectedFromCleanup(protections({ localFilePresent: (key) => key === "c.md" }), "c.md")).toBe(true);
    expect(protectedFromCleanup(protections({ ignored: (key) => key === "d.md" }), "d.md")).toBe(true);
  });
});

/**
 * A client that records the order in which things were removed.
 *
 * The order is the safety property under test, not an implementation detail: retiring the record while the
 * object survives turns a deleted note back into a live remote file that every device downloads.
 */
function client(overrides: Partial<R2Client> = {}): { client: R2Client; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      listObjects: async () => [],
      listTombstones: async () => [],
      // The object is still there, at the version the record names, and has not been written since.
      headObject: async (key: string) => { calls.push(`head:${key}`); return { key, size: 12, etag: `etag-${key}`, lastModified: RECORD_ACCEPTED_AT - 60_000 }; },
      getObject: async () => { throw new Error("unused"); },
      putObject: async () => { throw new Error("unused"); },
      deleteObject: async (key: string) => { calls.push(`object:${key}`); },
      deleteTombstone: async (record) => { calls.push(`record:${record.path}`); },
      ...overrides,
    },
  };
}

describe("cleanup", () => {
  const expired = deletion("old.md", ago(TOMBSTONE_RETENTION_MS + 1));

  it("keeps the current deletion even after the retention window", async () => {
    const logs: string[] = [];
    const { client: subject, calls } = client({
      listTombstones: async () => [expired, deletion("fresh.md", ago(1_000)), deletion("held.md", ago(TOMBSTONE_RETENTION_MS + 1))],
    });

    const result = await pruneExpiredTombstones(subject, { now: NOW, protect: (path) => path === "held.md", debug: (message) => logs.push(message) });

    expect(calls).toEqual(["head:old.md"]);
    expect(result).toEqual({ removed: 0, retained: 3, objects: 0 });
    expect(logs).toContain("tombstone cleanup removed=0 retained=3 objects=0");
  });

  it("keeps an unexpired record, and its bytes, even when nothing protects it", async () => {
    const { client: subject, calls } = client({ listTombstones: async () => [deletion("fresh.md", ago(1_000))] });
    expect(await pruneExpiredTombstones(subject, { now: NOW, protect: () => false })).toEqual({ removed: 0, retained: 1, objects: 0 });
    expect(calls).toEqual([]);
  });

  it("keeps an expired record while a conflict still needs it", async () => {
    const { client: subject, calls } = client({ listTombstones: async () => [expired, deletion("pending.md", ago(TOMBSTONE_RETENTION_MS + 1))] });
    // A pending deletion is exactly the case the retention window must not overrule.
    const result = await pruneExpiredTombstones(subject, { now: NOW, protect: (path) => path === "pending.md" });

    expect(result).toEqual({ removed: 0, retained: 2, objects: 0 });
    expect(calls).toEqual(["head:old.md"]);
  });
});

/**
 * The three states an object can be in, and which of them allow the bytes to go.
 *
 * The record is metadata; the object is the note. Every case here is about proving that a version is
 * genuinely deleted content before anything physical happens to it.
 */
describe("what may be physically removed", () => {
  const expired = deletion("old.md", ago(TOMBSTONE_RETENTION_MS + 1));

  it("keeps the record when the object is gone because it is the remaining deletion evidence", async () => {
    const { client: subject, calls } = client({
      listTombstones: async () => [expired],
      headObject: async (key: string) => { calls.push(`head:${key}`); throw new RemoteHttpError("HeadObject", 404); },
    });

    const result = await pruneExpiredTombstones(subject, { now: NOW, protect: () => false });

    expect(calls).toEqual(["head:old.md"]);
    expect(result).toEqual({ removed: 0, retained: 1, objects: 0 });
  });

  it("retires only the record when the path was revived with different content", async () => {
    const { client: subject, calls } = client({
      listTombstones: async () => [expired],
      headObject: async (key: string) => { calls.push(`head:${key}`); return { key, size: 4, etag: "etag-revived", lastModified: RECORD_ACCEPTED_AT + 60_000 }; },
    });

    const result = await pruneExpiredTombstones(subject, { now: NOW, protect: () => false });

    // The object is a live file now, so it is never touched; the record can never describe it again.
    expect(calls).toEqual(["head:old.md", "record:old.md"]);
    expect(result).toEqual({ removed: 1, retained: 0, objects: 0 });
  });

  it("retires only the record when the object was written after the record was accepted", async () => {
    // Identical bytes uploaded again produce an identical ETag, so the version alone cannot tell a
    // deletion from a revival. R2's own timestamps can, and they say this object came afterwards — which
    // makes the record dead metadata: a full scan no longer lets it hide that object either.
    const { client: subject, calls } = client({
      listTombstones: async () => [expired],
      headObject: async (key: string) => { calls.push(`head:${key}`); return { key, size: 12, etag: `etag-${key}`, lastModified: RECORD_ACCEPTED_AT + 1 }; },
    });

    const result = await pruneExpiredTombstones(subject, { now: NOW, protect: () => false, retentionMs: TOMBSTONE_RETENTION_MS });

    expect(calls).toEqual(["head:old.md", "record:old.md"]);
    expect(result).toEqual({ removed: 1, retained: 0, objects: 0 });
  });

  it("leaves both alone when the record has no server timestamp to compare", async () => {
    const withoutTime: RemoteDeletion = { tombstone: expired.tombstone, metadataETag: "meta" };
    const { client: subject, calls } = client({ listTombstones: async () => [withoutTime] });

    const result = await pruneExpiredTombstones(subject, { now: NOW, protect: () => false });

    // Without it there is no way to tell the deleted version from the same content re-uploaded later.
    expect(calls).toEqual(["head:old.md"]);
    expect(result).toEqual({ removed: 0, retained: 1, objects: 0 });
  });

  it("never removes bytes when the client cannot delete an object", async () => {
    const { client: subject, calls } = client({ listTombstones: async () => [expired], deleteObject: undefined });

    const result = await pruneExpiredTombstones(subject, { now: NOW, protect: () => false });

    // Removing the record while the object stands would resurrect the note on every device.
    expect(calls).toEqual(["head:old.md"]);
    expect(result).toEqual({ removed: 0, retained: 1, objects: 0 });
  });

  it("keeps both when the object cannot be read at all", async () => {
    const { client: subject, calls } = client({
      listTombstones: async () => [expired],
      headObject: async (key: string) => { calls.push(`head:${key}`); throw new RemoteHttpError("HeadObject", 503); },
    });

    expect(await pruneExpiredTombstones(subject, { now: NOW, protect: () => false })).toEqual({ removed: 0, retained: 1, objects: 0 });
    expect(calls).toEqual(["head:old.md"]);
  });

  it("never attempts to remove the current bytes or record", async () => {
    const { client: subject, calls } = client({
      listTombstones: async () => [expired],
      deleteTombstone: async (record) => { calls.push(`record:${record.path}`); throw new RemoteHttpError("DeleteTombstone", 403); },
    });

    const result = await pruneExpiredTombstones(subject, { now: NOW, protect: () => false });

    expect(calls).toEqual(["head:old.md"]);
    expect(result).toEqual({ removed: 0, retained: 1, objects: 0 });
  });

  it("is a no-op, not a failure, for a client without the capability", async () => {
    const { client: subject } = client({ listTombstones: undefined, deleteTombstone: undefined, deleteObject: undefined });
    expect(await pruneExpiredTombstones(subject, { now: NOW, protect: () => false })).toBeUndefined();
  });

  it("keeps going when one path cannot be retired", async () => {
    const logs: string[] = [];
    const { client: subject, calls } = client({
      listTombstones: async () => [expired, deletion("second.md", ago(TOMBSTONE_RETENTION_MS + 1))],
      headObject: async (key: string) => {
        calls.push(`head:${key}`);
        return key === "old.md"
          ? { key, size: 12, etag: `etag-${key}`, lastModified: RECORD_ACCEPTED_AT - 60_000 }
          : { key, size: 8, etag: "revived", lastModified: RECORD_ACCEPTED_AT + 60_000 };
      },
    });

    const result = await pruneExpiredTombstones(subject, { now: NOW, protect: () => false, debug: (message) => logs.push(message) });

    // The current deletion stays; the demonstrably revived path loses only stale metadata.
    expect(calls).toEqual(["head:old.md", "head:second.md", "record:second.md"]);
    expect(result).toEqual({ removed: 1, retained: 1, objects: 0 });
    // Only a digest is ever logged, never the path.
    expect(logs.join("\n")).not.toContain("old.md");
  });

  it("raises when the records cannot be listed at all", async () => {
    // "We could not look" is not "nothing was old enough", so it must not be reported as a clean pass.
    const { client: subject } = client({ listTombstones: async () => { throw new RemoteHttpError("ListTombstonesV2", 500); } });
    await expect(pruneExpiredTombstones(subject, { now: NOW, protect: () => false })).rejects.toThrow();
  });
});
