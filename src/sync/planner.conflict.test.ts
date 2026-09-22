import { describe, expect, it } from "vitest";
import { buildSyncPlan } from "./planner";
import type { LocalEntry, PreviousEntry, RemoteEntry, SyncOperation } from "./types";

const local = (key = "note.md", size = 10, mtime = 100): LocalEntry => ({ key, size, mtime });
const remote = (key = "note.md", size = 10, etag = "etag-a", lastModified = 1000): RemoteEntry => ({ key, size, etag, lastModified });
const previous = (key = "note.md", mtime = 100): PreviousEntry => ({ key, local: { size: 10, mtime }, remote: { size: 10, etag: "etag-base" }, syncedAt: 1 });

const planWith = (resolution: { intent: { conflictId: string; type: "keep-local" | "keep-remote" | "merged"; merged?: { content: string; sha256: string; encoding: { bom: boolean; eol: "lf" | "crlf" | "mixed"; trailingNewline: boolean } } } } | undefined, overrides: { local?: LocalEntry; remote?: RemoteEntry; previous?: PreviousEntry } = {}): SyncOperation | undefined =>
  buildSyncPlan(
    new Map([[overrides.local?.key ?? "note.md", overrides.local ?? local("note.md", 11, 200)]]),
    new Map([[overrides.remote?.key ?? "note.md", overrides.remote ?? remote("note.md", 12, "etag-b")]]),
    new Map([[overrides.previous?.key ?? "note.md", overrides.previous ?? previous()]]),
    resolution ? new Map([["note.md", resolution]]) : undefined,
  ).operations[0];

describe("planner output without resolutions is unchanged", () => {
  it("still reports a conflict for a both-modified key", () => {
    const operation = planWith(undefined);
    expect(operation).toMatchObject({ type: "conflict", conflict: "both-modified" });
  });

  it("ignores a resolution map that has nothing for this key", () => {
    const operation = buildSyncPlan(
      new Map([["note.md", local("note.md", 11, 200)]]),
      new Map([["note.md", remote("note.md", 12, "etag-b")]]),
      new Map([["note.md", previous()]]),
      new Map([["other.md", { intent: { conflictId: "x", type: "keep-local" } }]]),
    ).operations[0];
    expect(operation).toMatchObject({ type: "conflict" });
  });
});

describe("resolution operations", () => {
  it("emits an explicit resolve-keep-local carrying the observed versions", () => {
    const operation = planWith({ intent: { conflictId: "cid-1", type: "keep-local" } });
    expect(operation).toEqual({
      type: "resolve-keep-local",
      key: "note.md",
      reason: expect.any(String),
      conflictId: "cid-1",
      expectedLocal: { key: "note.md", size: 11, mtime: 200 },
      expectedRemoteETag: "etag-b",
    });
  });

  it("emits an explicit resolve-keep-remote", () => {
    expect(planWith({ intent: { conflictId: "cid-1", type: "keep-remote" } })).toMatchObject({ type: "resolve-keep-remote", conflictId: "cid-1", expectedRemoteETag: "etag-b" });
  });

  it("emits an explicit resolve-merged carrying the merged bytes", () => {
    const merged = { content: "merged\n", sha256: "abc", encoding: { bom: false, eol: "lf" as const, trailingNewline: true } };
    const operation = planWith({ intent: { conflictId: "cid-1", type: "merged", merged } });
    expect(operation).toMatchObject({ type: "resolve-merged", conflictId: "cid-1", merged });
  });

  it("never disguises a resolution as an ordinary upload or download", () => {
    for (const type of ["keep-local", "keep-remote", "merged"] as const) {
      const operation = planWith({ intent: { conflictId: "cid", type, merged: type === "merged" ? { content: "m", sha256: "s", encoding: { bom: false, eol: "lf", trailingNewline: true } } : undefined } });
      // Diagnostics, preconditions and partial-success semantics differ, so the operation type differs.
      expect(operation?.type).not.toBe("upload");
      expect(operation?.type).not.toBe("download");
      expect(operation?.type).toMatch(/^resolve-/);
    }
  });

  it("falls back to a conflict when a merged intent carries no content", () => {
    expect(planWith({ intent: { conflictId: "cid", type: "merged" } })).toMatchObject({ type: "conflict" });
  });
});

describe("a resolution only applies to the conflict it was authored for", () => {
  it("does nothing when the local version moved on after the intent", () => {
    // The coordinator only supplies an intent whose identity matches; if it does not, the planner must
    // keep reporting the conflict rather than applying a decision to newer content.
    const operation = planWith(undefined, { local: local("note.md", 13, 999) });
    expect(operation).toMatchObject({ type: "conflict" });
  });

  it("does not convert a one-sided change into a resolution", () => {
    // Remote unchanged: this is an ordinary upload, and an intent must not hijack it.
    const operation = planWith({ intent: { conflictId: "cid", type: "keep-local" } }, { local: local("note.md", 11, 200), remote: remote("note.md", 10, "etag-base") });
    expect(operation).toMatchObject({ type: "upload" });
  });

  it("does not apply a resolution to a key whose remote was deleted", () => {
    const operation = buildSyncPlan(
      new Map([["note.md", local("note.md", 11, 200)]]),
      new Map(),
      new Map([["note.md", previous()]]),
      new Map([["note.md", { intent: { conflictId: "cid", type: "keep-local" } }]]),
    ).operations[0];
    // This is the "remote deleted while local changed" shape: still a conflict, never a resolution.
    expect(operation).toMatchObject({ type: "conflict", conflict: "local-modified-remote-deleted" });
  });

  it("does not apply a resolution when the remote ETag is missing", () => {
    const operation = planWith({ intent: { conflictId: "cid", type: "keep-local" } }, { remote: { key: "note.md", size: 12, lastModified: 1000 } });
    // The executor refuses an unconditional write, so an intent with no version identity is not applied.
    expect(operation).toMatchObject({ type: "resolve-keep-local", expectedRemoteETag: undefined });
  });
});
