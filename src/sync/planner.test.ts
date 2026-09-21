import { describe, expect, it } from "vitest";
import { canonicalKey, normalizePrefix, remoteObjectKey, vaultKeyFromRemote } from "./path";
import { buildSyncPlan } from "./planner";
import type { LocalEntry, PreviousEntry, RemoteEntry, SyncOperation } from "./types";

const local = (key = "note.md", size = 10, mtime = 100): LocalEntry => ({ key, size, mtime });
const remote = (key = "note.md", size = 10, etag: string | undefined = "etag-a", lastModified = 1000): RemoteEntry => ({ key, size, etag, lastModified });
const previous = (key = "note.md", size = 10, mtime = 100, etag: string | undefined = "etag-a", lastModified = 1000): PreviousEntry => ({ key, local: { size, mtime }, remote: { size, etag, lastModified }, syncedAt: 1 });
const plan = (l?: LocalEntry, r?: RemoteEntry, p?: PreviousEntry): SyncOperation | undefined => buildSyncPlan(new Map(l ? [[l.key, l]] : []), new Map(r ? [[r.key, r]] : []), new Map(p ? [[p.key, p]] : [])).operations[0];

describe("buildSyncPlan decision matrix", () => {
  it.each([
    ["new local", local(), undefined, undefined, "upload"],
    ["new remote", undefined, remote(), undefined, "download"],
    ["both new", local(), remote(), undefined, "conflict"],
    ["unchanged", local(), remote(), previous(), "noop"],
    ["local modified", local("note.md", 10, 101), remote(), previous(), "upload"],
    ["remote modified", local(), remote("note.md", 10, "etag-b"), previous(), "download"],
    ["both modified", local("note.md", 10, 101), remote("note.md", 10, "etag-b"), previous(), "conflict"],
    ["local deleted", undefined, remote(), previous(), "delete-remote"],
    ["remote deleted", local(), undefined, previous(), "delete-local"],
    ["both deleted", undefined, undefined, previous(), "noop"],
    ["local changed remote deleted", local("note.md", 10, 101), undefined, previous(), "conflict"],
    ["local deleted remote changed", undefined, remote("note.md", 10, "etag-b"), previous(), "conflict"],
  ] as const)("%s", (_name, l, r, p, expected) => expect(plan(l, r, p)?.type).toBe(expected));

  it("compares same-size local changes by mtime", () => expect(plan(local("note.md", 10, 101), remote(), previous())?.type).toBe("upload"));
  it("compares same-mtime local changes by size", () => expect(plan(local("note.md", 11, 100), remote(), previous())?.type).toBe("upload"));
  it("treats an ETag change as remote change", () => expect(plan(local(), remote("note.md", 10, "etag-b"), previous())?.type).toBe("download"));
  it("uses size plus lastModified if neither baseline nor remote has ETag", () => {
    const p: PreviousEntry = { key: "note.md", local: { size: 10, mtime: 100 }, remote: { size: 10, lastModified: 1000 }, syncedAt: 1 };
    expect(plan(local(), { key: "note.md", size: 10, lastModified: 1001 }, p)?.type).toBe("download");
    expect(plan(local(), { key: "note.md", size: 10, lastModified: 1000 }, p)?.type).toBe("noop");
  });
  it("is deterministic, sorted, and has one operation per key", () => {
    const l = new Map([["z.md", local("z.md")], ["a.md", local("a.md")]]);
    const one = buildSyncPlan(l, new Map(), new Map()), two = buildSyncPlan(l, new Map(), new Map());
    expect(one).toEqual(two); expect(one.operations.map((item) => item.key)).toEqual(["a.md", "z.md"]);
    expect(new Set(one.operations.map((item) => item.key)).size).toBe(one.operations.length);
  });
  it("never combines a conflict with a destructive or transfer operation", () => {
    const result = buildSyncPlan(new Map([["note.md", local("note.md", 10, 101)]]), new Map([["note.md", remote("note.md", 10, "etag-b")]]), new Map([["note.md", previous()]]));
    expect(result.operations).toEqual([expect.objectContaining({ type: "conflict", conflict: "both-modified" })]);
  });
  it("does not propagate a deletion without previous successful-state evidence", () => {
    expect(buildSyncPlan(new Map(), new Map([["only-remote.md", remote("only-remote.md")]]), new Map()).operations).toEqual([expect.objectContaining({ type: "download" })]);
  });
});

describe("path normalization", () => {
  it("uses vault-relative slash-separated keys and normalized prefixes", () => {
    expect(canonicalKey("folder\\note.md")).toBe("folder/note.md");
    expect(normalizePrefix("sync//")).toBe("sync/");
    expect(remoteObjectKey("sync", "folder/note.md")).toBe("sync/folder/note.md");
    expect(vaultKeyFromRemote("sync", "sync/folder/note.md")).toBe("folder/note.md");
  });
  it.each(["/../note.md", "folder/../note.md", "", "folder//note.md"])("rejects non-canonical traversal or empty paths: %s", (value) => expect(() => canonicalKey(value)).toThrow());
});
