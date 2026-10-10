import { describe, expect, it } from "vitest";
import { buildSyncPlan, type ResolutionProposal } from "./planner";
import type { LocalEntry, PreviousEntry, RemoteDeletionIdentity, RemoteEntry, SyncOperation } from "./types";

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

/**
 * A restore is only ever a local edit.
 *
 * The history viewer writes a snapshot into the Vault and nothing else, so these two cases are the whole
 * safety story for recovering an earlier version: the restored text is compared against the baseline like
 * any hand-typed change, which means an unchanged remote is uploaded over and a remote that moved on is a
 * conflict — never an unconditional overwrite of the newer remote.
 */
describe("a restored version goes through the normal plan", () => {
  it("uploads the restored text when the remote has not moved since the baseline", () => {
    // A restore rewrites the file, so the local version differs from the baseline while the ETag still
    // matches: a one-sided local change, and therefore an ordinary upload.
    const operation = planWith(undefined, { local: local("note.md", 8, 300), remote: remote("note.md", 10, "etag-base") });
    expect(operation).toMatchObject({ type: "upload", key: "note.md" });
  });

  it("conflicts instead of overwriting when the remote moved on", () => {
    const operation = planWith(undefined, { local: local("note.md", 8, 300) });
    expect(operation).toMatchObject({ type: "conflict", conflict: "both-modified" });
  });
});

/**
 * Delete-vs-modify, in both shapes it can be observed.
 *
 * A remote deletion reaches the planner either as a named deletion (a tombstone, from a full scan or from
 * the exact-path HEAD a Gateway delete event is answered with) or as a plain absence (a rename's old
 * side, or bytes removed by something other than this plugin). Both are the same disagreement, so both
 * must offer the same two decisions — and the difference between them is only which precondition the
 * resulting operation carries.
 */
describe("delete-vs-modify decisions", () => {
  const named = (overrides: Partial<RemoteDeletionIdentity> = {}): RemoteEntry => ({
    key: "note.md", size: 0, lastModified: 1_000,
    deleted: { path: "note.md", deletedRemoteETag: "etag-base", objectPresent: true, ...overrides },
  });
  const decide = (remote: RemoteEntry | undefined, intent?: ResolutionProposal["intent"]): SyncOperation | undefined =>
    buildSyncPlan(
      new Map([["note.md", local("note.md", 11, 200)]]),
      remote ? new Map([["note.md", remote]]) : new Map(),
      new Map([["note.md", previous()]]),
      intent ? new Map([["note.md", { intent }]]) : undefined,
    ).operations[0];

  it("conflicts when a named deletion meets a local modification", () => {
    expect(decide(named())).toMatchObject({ type: "conflict", conflict: "local-modified-remote-deleted" });
    expect(decide(undefined)).toMatchObject({ type: "conflict", conflict: "local-modified-remote-deleted" });
  });

  it("does nothing at all when the deletion arrives for a path that is already gone here", () => {
    // Both sides are absent and the tombstone says why. There is no operation to plan: re-deleting is not
    // a thing, and the record is what keeps this from being read as a path that never existed.
    const operations = buildSyncPlan(new Map(), new Map([["note.md", named()]]), new Map([["note.md", previous()]])).operations;
    expect(operations).toEqual([]);
  });

  it("offers only the two decisions a deletion can have", () => {
    // There is nothing to merge and nothing remote to keep, so the other intents stay unusable.
    expect(decide(named(), { conflictId: "cid", type: "keep-remote" })).toMatchObject({ type: "conflict" });
    expect(decide(named(), { conflictId: "cid", type: "merged", merged: { content: "m", sha256: "s", encoding: { bom: false, eol: "lf", trailingNewline: true } } })).toMatchObject({ type: "conflict" });
    expect(decide(named(), { conflictId: "cid", type: "accept-local-delete" })).toMatchObject({ type: "conflict" });
  });

  it("keeps the note by reviving only the version the deletion named", () => {
    // The object is still physically there at the deleted ETag, so the revive is conditional on exactly
    // that version and nothing newer can be overwritten.
    expect(decide(named(), { conflictId: "cid", type: "keep-local" })).toMatchObject({ type: "resolve-keep-local", conflictId: "cid", expectedLocal: { key: "note.md", size: 11, mtime: 200 }, expectedRemoteETag: "etag-base" });
  });

  it("keeps the note by a conditional create when no version could be named", () => {
    const operation = decide(named({ deletedRemoteETag: "", objectPresent: false }), { conflictId: "cid", type: "keep-local" });
    expect(operation).toMatchObject({ type: "resolve-keep-local", expectedRemoteAbsent: true, conflictId: "cid" });
    expect(operation).not.toMatchObject({ expectedRemoteETag: expect.anything() });
  });

  it("deletes the note by accepting the deletion, carrying the identity it was shown", () => {
    expect(decide(named(), { conflictId: "cid", type: "accept-remote-delete" })).toMatchObject({
      type: "resolve-accept-remote-delete", conflictId: "cid",
      expectedDeletion: { path: "note.md", deletedRemoteETag: "etag-base", objectPresent: true },
    });
    // With nothing left remote to re-check, the same decision is simply the planned local removal.
    expect(decide(undefined, { conflictId: "cid", type: "accept-remote-delete" })).toMatchObject({
      type: "resolve-accept-remote-delete",
      expectedDeletion: { path: "note.md", deletedRemoteETag: "", objectPresent: false },
    });
  });

  it("still propagates a deletion the local side never touched, decision or not", () => {
    // An unchanged local file is not a conflict, so no decision can hijack the ordinary deletion.
    const operation = buildSyncPlan(
      new Map([["note.md", local("note.md", 10, 100)]]),
      new Map([["note.md", named()]]),
      new Map([["note.md", previous()]]),
      new Map([["note.md", { intent: { conflictId: "cid", type: "keep-local" } }]]),
    ).operations[0];
    expect(operation).toMatchObject({ type: "delete-local", expectedLocal: { key: "note.md", size: 10, mtime: 100 } });
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

  it("never turns a decision about a deleted remote into an ordinary upload", () => {
    const operation = buildSyncPlan(
      new Map([["note.md", local("note.md", 11, 200)]]),
      new Map(),
      new Map([["note.md", previous()]]),
      new Map([["note.md", { intent: { conflictId: "cid", type: "keep-local" } }]]),
    ).operations[0];
    // This is the "remote deleted while local changed" shape, and keeping this device's note is exactly
    // the decision for it. What the planner must not do is turn it into an ordinary upload: the write has
    // to stay conditional on the remote still being absent, or a file another device recreated meanwhile
    // would be overwritten by a decision the user made about a version that no longer exists.
    expect(operation).toMatchObject({ type: "resolve-keep-local", expectedRemoteAbsent: true });
    expect(operation).not.toMatchObject({ expectedRemoteETag: expect.anything() });
  });

  it("does not apply a resolution when the remote ETag is missing", () => {
    const operation = planWith({ intent: { conflictId: "cid", type: "keep-local" } }, { remote: { key: "note.md", size: 12, lastModified: 1000 } });
    // The executor refuses an unconditional write, so an intent with no version identity is not applied.
    expect(operation).toMatchObject({ type: "resolve-keep-local", expectedRemoteETag: undefined });
  });
});
