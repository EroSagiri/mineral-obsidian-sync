import { describe, expect, it } from "vitest";
import { canonicalKey, normalizePrefix, remoteObjectKey, vaultKeyFromRemote } from "./path";
import { buildSyncPlan } from "./planner";
import type { LocalEntry, PreviousEntry, RemoteEntry, SyncOperation } from "./types";

const local = (key = "note.md", size = 10, mtime = 100): LocalEntry => ({ key, size, mtime });
const remote = (key = "note.md", size = 10, etag: string | undefined = "etag-a", lastModified = 1000): RemoteEntry => ({ key, size, etag, lastModified });
const previous = (key = "note.md", size = 10, mtime = 100, etag: string | undefined = "etag-a", lastModified = 1000): PreviousEntry => ({ key, local: { size, mtime }, remote: { size, etag, lastModified }, syncedAt: 1 });
const plan = (l?: LocalEntry, r?: RemoteEntry, p?: PreviousEntry): SyncOperation | undefined => buildSyncPlan(new Map(l ? [[l.key, l]] : []), new Map(r ? [[r.key, r]] : []), new Map(p ? [[p.key, p]] : [])).operations[0];

describe("buildSyncPlan with a baseline recorded from a write", () => {
  const baseline = (etag: string | undefined, lastModified: number | undefined): PreviousEntry => ({ key: "note.md", local: { size: 10, mtime: 100 }, remote: { size: 10, etag, lastModified }, syncedAt: 1 });
  /** The shared `remote()` helper cannot express "no ETag": passing undefined there triggers its default. */
  const scanned = (etag: string | undefined, lastModified: number): RemoteEntry => ({ key: "note.md", size: 10, etag, lastModified });

  it("prefers the ETag when the baseline carries no server timestamp", () => {
    // Recorded from a PUT: ETag known, lastModified unknown. The scan's real timestamp must not be
    // mistaken for a change.
    expect(plan(local(), scanned("etag-a", 999_999), baseline("etag-a", undefined))?.type).toBe("noop");
    expect(plan(local(), scanned("etag-b", 1000), baseline("etag-a", undefined))?.type).toBe("download");
  });

  it("treats a baseline with neither ETag nor timestamp as changed rather than as unchanged", () => {
    // Without any identifier the safe direction is "changed": it can cost a redundant download or a
    // conflict report, but it can never hide a real remote change.
    expect(plan(local(), scanned(undefined, 1000), baseline(undefined, undefined))?.type).toBe("download");
    expect(plan(local(), scanned(undefined, 1000), baseline(undefined, 1000))?.type).toBe("noop");
  });

  it("falls back to the server timestamp only when both sides lack an ETag", () => {
    expect(plan(local(), scanned(undefined, 2000), baseline(undefined, 1000))?.type).toBe("download");
    expect(plan(local(), scanned(undefined, 1000), baseline(undefined, 1000))?.type).toBe("noop");
  });
});

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
    ["both deleted", undefined, undefined, previous(), "prune-baseline"],
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

describe("baseline GC and safe local deletion", () => {
  it("retires a baseline only when the local and remote scans both prove absence", () => {
    // Three baseline entries; only the fully-absent one may be forgotten.
    const stored = new Map([
      ["gone.md", previous("gone.md")],
      ["local-only.md", previous("local-only.md")],
      ["remote-only.md", previous("remote-only.md")],
    ]);
    const scannedLocal = new Map([["local-only.md", local("local-only.md")]]);
    const scannedRemote = new Map([["remote-only.md", remote("remote-only.md")]]);
    const operations = buildSyncPlan(scannedLocal, scannedRemote, stored).operations;
    expect(operations).toEqual([
      expect.objectContaining({ type: "prune-baseline", key: "gone.md" }),
      expect.objectContaining({ type: "delete-local", key: "local-only.md" }),
      // The third key still exists remotely while the local copy is gone, so the local absence is a
      // deletion to propagate upward — and that direction stays blocked until D3 gives it a version.
      expect.objectContaining({ type: "delete-remote", key: "remote-only.md" }),
    ]);
  });

  it("forgets only the absent keys and leaves real content alone", () => {
    // The same three-key baseline, scanned again: the GC candidate is exactly the absent one.
    const stored = new Map([
      ["gone.md", previous("gone.md")],
      ["kept.md", previous("kept.md")],
    ]);
    const operations = buildSyncPlan(new Map([["kept.md", local("kept.md")]]), new Map([["kept.md", remote("kept.md")]]), stored).operations;
    expect(operations.filter((operation) => operation.type === "prune-baseline").map((operation) => operation.key)).toEqual(["gone.md"]);
    expect(operations.filter((operation) => operation.type === "noop").map((operation) => operation.key)).toEqual(["kept.md"]);
  });

  it("carries the observed local version on the delete-local decision", () => {
    // The executor revalidates this exact observation before any destructive action, so the planner
    // must hand over the version the decision was made from, not just the key. This local version
    // still matches the baseline, which is what makes the deletion safe to plan at all.
    const operation = plan(local("note.md", 10, 100), undefined, previous("note.md"));
    expect(operation).toEqual({ type: "delete-local", key: "note.md", reason: expect.any(String), expectedLocal: { key: "note.md", size: 10, mtime: 100 } });
  });

  it("never turns a modified local file into a delete-local when the remote is gone", () => {
    // Local changed after the baseline, remote absent: this is a conflict, never a deletion.
    expect(plan(local("note.md", 10, 999), undefined, previous("note.md"))?.type).toBe("conflict");
  });

  it("never emits prune-baseline or delete-local without a previous entry", () => {
    expect(buildSyncPlan(new Map(), new Map(), new Map()).operations).toEqual([]);
    // A brand-new remote-only object is a download; a brand-new local-only file is an upload.
    expect(buildSyncPlan(new Map([["new.md", local("new.md")]]), new Map(), new Map()).operations).toEqual([expect.objectContaining({ type: "upload" })]);
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
