import { describe, expect, it } from "vitest";
import { TOMBSTONE_PROTOCOL, encodeTombstone, parseTombstone, tombstoneKey, tombstoneReadKeys } from "./tombstones";

describe("logical deletion tombstones", () => {
  const record = { protocol: TOMBSTONE_PROTOCOL, path: "notes/a.md", deletedRemoteETag: "etag-A", createdAt: "2026-09-22T00:00:00.000Z" } as const;

  it("derives an opaque deterministic key from both canonical path and deleted version", async () => {
    expect(await tombstoneKey(record.path, record.deletedRemoteETag)).toMatch(/^\.mineral\/tombstones\/[A-Za-z0-9_-]+\.json$/);
    expect(await tombstoneKey(record.path, record.deletedRemoteETag)).not.toEqual(await tombstoneKey(record.path, "etag-B"));
  });

  it("reads the equivalent legacy key while writing only under .mineral", async () => {
    await expect(tombstoneReadKeys(record.path, record.deletedRemoteETag)).resolves.toEqual([
      await tombstoneKey(record.path, record.deletedRemoteETag),
      expect.stringMatching(/^\.mineral-sync\/tombstones\/[A-Za-z0-9_-]+\.json$/),
    ]);
  });

  it("round-trips valid metadata but fails closed on malformed or traversal paths", () => {
    expect(parseTombstone(encodeTombstone(record))).toEqual(record);
    const bad = new TextEncoder().encode('{"protocol":1,"path":"../a.md","deletedRemoteETag":"A","createdAt":"2026-09-22T00:00:00.000Z"}').buffer;
    expect(() => parseTombstone(bad)).toThrow(/Path must be/);
  });
});
