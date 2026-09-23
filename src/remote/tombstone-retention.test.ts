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
const deletion = (path: string, createdAt: string): RemoteDeletion => ({
  tombstone: { protocol: 1, path, deletedRemoteETag: `etag-${path}`, createdAt },
  metadataETag: `meta-${path}`,
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

function client(overrides: Partial<R2Client> = {}): { client: R2Client; deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    client: {
      listObjects: async () => [],
      listTombstones: async () => [],
      headObject: async () => { throw new Error("unused"); },
      getObject: async () => { throw new Error("unused"); },
      putObject: async () => { throw new Error("unused"); },
      deleteObject: async (record) => { deleted.push(record.path); },
      ...overrides,
    },
  };
}

describe("cleanup", () => {
  const expired = deletion("old.md", ago(TOMBSTONE_RETENTION_MS + 1));

  it("removes only expired records that nothing local still needs", async () => {
    const logs: string[] = [];
    const { client: subject, deleted } = client({
      listTombstones: async () => [expired, deletion("fresh.md", ago(1_000)), deletion("held.md", ago(TOMBSTONE_RETENTION_MS + 1))],
    });

    const result = await pruneExpiredTombstones(subject, { now: NOW, protect: (path) => path === "held.md", debug: (message) => logs.push(message) });

    expect(deleted).toEqual(["old.md"]);
    // Both counts are reported, because "nothing was old enough" and "everything was protected" are
    // different situations that look identical from the outside.
    expect(result).toEqual({ removed: 1, retained: 2 });
    expect(logs).toContain("tombstone cleanup removed=1 retained=2");
  });

  it("keeps an unexpired record even when nothing protects it", async () => {
    const { client: subject, deleted } = client({ listTombstones: async () => [deletion("fresh.md", ago(1_000))] });
    expect(await pruneExpiredTombstones(subject, { now: NOW, protect: () => false })).toEqual({ removed: 0, retained: 1 });
    expect(deleted).toEqual([]);
  });

  it("keeps an expired record while a conflict still needs it", async () => {
    const { client: subject, deleted } = client({ listTombstones: async () => [expired, deletion("pending.md", ago(TOMBSTONE_RETENTION_MS + 1))] });
    // A pending deletion is exactly the case the retention window must not overrule.
    const result = await pruneExpiredTombstones(subject, { now: NOW, protect: (path) => path === "pending.md" });

    expect(result).toEqual({ removed: 1, retained: 1 });
    expect(deleted).toEqual(["old.md"]);
  });

  it("is a no-op, not a failure, for a client without the capability", async () => {
    const { client: subject } = client({ listTombstones: undefined, deleteObject: undefined });
    expect(await pruneExpiredTombstones(subject, { now: NOW, protect: () => false })).toBeUndefined();
  });

  it("keeps going when one record cannot be removed", async () => {
    const logs: string[] = [];
    const { client: subject, deleted } = client({
      listTombstones: async () => [expired, deletion("second.md", ago(TOMBSTONE_RETENTION_MS + 1))],
      deleteObject: async (record) => {
        if (record.path === "old.md") throw new RemoteHttpError("DeleteObject", 403);
        deleted.push(record.path);
      },
    });

    const result = await pruneExpiredTombstones(subject, { now: NOW, protect: () => false, debug: (message) => logs.push(message) });

    expect(deleted).toEqual(["second.md"]);
    expect(result).toEqual({ removed: 1, retained: 1 });
    expect(logs.some((line) => line.startsWith("tombstone cleanup failed path-digest="))).toBe(true);
    // Only a digest is ever logged, never the path.
    expect(logs.join("\n")).not.toContain("old.md");
  });

  it("raises when the records cannot be listed at all", async () => {
    // "We could not look" is not "nothing was old enough", so it must not be reported as a clean pass.
    const { client: subject } = client({ listTombstones: async () => { throw new RemoteHttpError("ListTombstonesV2", 500); } });
    await expect(pruneExpiredTombstones(subject, { now: NOW, protect: () => false })).rejects.toThrow();
  });
});
