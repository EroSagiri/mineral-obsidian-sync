import { describe, expect, it } from "vitest";
import { CONFLICT_PROTOCOL_VERSION, type ConflictRecord } from "../conflict/types";
import { combineAdditions, presentConflict, significantText } from "./conflict-presentation";

/**
 * The resolver's view model: which result may be suggested, and which differences are worth showing.
 *
 * Nothing here decides a merge. A suggestion exists only when the coordinator, the engine or a provably
 * safe combination produced one; otherwise the view says so and asks the user to write the result.
 */

const record = (overrides: Partial<ConflictRecord> = {}): ConflictRecord => ({
  protocolVersion: CONFLICT_PROTOCOL_VERSION,
  conflictId: "conflict-identity-1",
  channel: "A".repeat(43),
  path: "notes/a.md",
  previous: { localVersion: { key: "notes/a.md", size: 10, mtime: 100 }, remoteETag: "BASELINE-ETAG" },
  observedLocal: { key: "notes/a.md", size: 11, mtime: 200 },
  observedRemoteETag: "REMOTE-ETAG",
  detectedAt: 1_700_000_000_000,
  autoMergeStatus: "manual-required",
  reason: "1 overlapping region(s)",
  snapshot: { baseAvailable: true, base: "", local: "", remote: "", draft: "" },
  ...overrides,
});

/** Both sides appended after the same shared lines — the case a prepared result is right for. */
const appended = (): ConflictRecord => record({
  snapshot: {
    baseAvailable: true,
    base: "windows\nsf\n",
    local: "windows\nsf\nfrom windows\n",
    remote: "windows\nsf\noppo\n",
    draft: "windows\nsf\n<<<<<<< LOCAL\nfrom windows\n=======\noppo\n>>>>>>> REMOTE\n",
  },
});

/** The same region replaced with different text: nothing can be suggested. */
const replaced = (): ConflictRecord => record({
  snapshot: { baseAvailable: true, base: "value = A\n", local: "value = B\n", remote: "value = C\n", draft: "value = B\n" },
});

/** The live incident: the other side only added a final newline. */
const incident = (): ConflictRecord => record({
  snapshot: { baseAvailable: true, base: "windows\nwindows", local: "windows\nwindows\nandroid\nandroid\n", remote: "windows\nwindows\n", draft: "" },
});

/** Two sides that differ only in end-of-line whitespace. */
const whitespaceOnly = (): ConflictRecord => record({
  snapshot: { baseAvailable: true, base: "a\nb\n", local: "a\nb \n", remote: "a\nb\t\n", draft: "" },
});

describe("presentation normalization", () => {
  it("treats line endings, trailing spaces and a final newline as storage, not content", () => {
    expect(significantText("a\r\nb\r\n")).toBe(significantText("a\nb"));
    expect(significantText("a \n")).toBe(significantText("a\n"));
    expect(significantText("a\nb\n\n\n")).toBe(significantText("a\nb"));
    expect(significantText("\uFEFFa\n")).toBe(significantText("a\n"));
    // Real content differences survive.
    expect(significantText("a\nB\n")).not.toBe(significantText("a\nb\n"));
  });

  it("does not present a pure formatting difference as the main conflict", () => {
    const view = presentConflict(whitespaceOnly());
    expect(view.kind).toBe("suggested");
    if (view.kind !== "suggested") return;
    expect(view.differencesAreNoise).toBe(true);
    expect(view.differences.map((difference) => difference.kind)).toEqual(["formatting-only"]);
    expect(view.suggestedText).toBe("a\nb \n");
  });
});

describe("suggested results", () => {
  it("uses the coordinator's own clean auto-merge first", () => {
    const view = presentConflict(record({
      autoMergeStatus: "clean",
      snapshot: { baseAvailable: true, base: "a\n", local: "a\nb\n", remote: "a\nc\n", draft: "a\nb\nc\n" },
    }));
    expect(view).toMatchObject({ kind: "suggested", source: "auto-merge", suggestedText: "a\nb\nc\n", label: "Suggested result" });
  });

  it("falls back to the engine's own clean result", () => {
    // Two edits that touch different lines: the engine merges them without a conflict region.
    const view = presentConflict(record({
      snapshot: { baseAvailable: true, base: "h1\nh2\nh3\n", local: "h1\nX\nh2\nh3\n", remote: "h1\nh2\nh3\nY\n", draft: "" },
    }));
    expect(view).toMatchObject({ kind: "suggested", source: "engine", suggestedText: "h1\nX\nh2\nh3\nY\n" });
  });

  it("combines two additions only when both sides extended the same ancestor content", () => {
    const view = presentConflict(appended());
    expect(view).toMatchObject({ kind: "suggested", source: "combination", suggestedText: "windows\nsf\nfrom windows\noppo\n" });
    if (view.kind !== "suggested") return;
    expect(view.differences[0]).toMatchObject({ kind: "both-added", title: "Both versions added content here" });
    expect(view.differences[0]!.current).toBe("from windows\n");
    expect(view.differences[0]!.other).toBe("oppo\n");
  });

  it("suggests the side that changed when the other side only matches the ancestor", () => {
    const view = presentConflict(incident());
    expect(view).toMatchObject({ kind: "suggested", source: "combination", suggestedText: "windows\nwindows\nandroid\nandroid\n" });
    if (view.kind !== "suggested") return;
    // The live incident is one-sided once formatting is ignored: no "the other side added a newline".
    expect(view.differences[0]).toMatchObject({ kind: "current-only", title: "Only this device changed this area" });
    expect(view.differences[0]!.current).toBe("windows\nandroid\nandroid\n");
    expect(view.differences[0]!.other).toBe("");
    expect(view.differences[0]!.note).toContain("matches the common ancestor");
  });

  it("never claims the versions added content when they actually replaced it", () => {
    const view = presentConflict(replaced());
    expect(view.kind).toBe("manual");
    if (view.kind !== "manual") return;
    expect(view.differences[0]).toMatchObject({ kind: "both-changed", title: "Both versions changed this area" });
    expect(JSON.stringify(view)).not.toContain("added content here");
  });
});

describe("when nothing can be suggested", () => {
  it("asks for a manual result instead of inventing one", () => {
    const view = presentConflict(replaced());
    expect(view.kind).toBe("manual");
    if (view.kind !== "manual") return;
    expect(view.notice).toContain("different ways");
    // The editor opens on this device's own text: no synthesized candidate, no markers.
    expect(view.draftText).toBe("value = B\n");
    expect(view.draftText).not.toContain("<<<<<<<");
  });

  it("explains a missing common ancestor", () => {
    const view = presentConflict(record({ autoMergeStatus: "base-unavailable", snapshot: { baseAvailable: false, local: "local\n", remote: "remote\n" } }));
    expect(view).toMatchObject({ kind: "manual", draftText: "local\n" });
    if (view.kind !== "manual") return;
    expect(view.notice).toContain("common ancestor");
    expect(view.differences).toEqual([]);
  });
});

describe("delete versus modify", () => {
  it("gets its own page when the other side deleted the note", () => {
    const view = presentConflict(record({
      observedRemoteDeletion: { path: "notes/a.md", deletedRemoteETag: "DELETED", createdAt: "2026-01-01T00:00:00.000Z", objectPresent: true },
      snapshot: { baseAvailable: true, local: "changed\n" },
    }));
    expect(view).toMatchObject({ kind: "delete-vs-modify", deletedSide: "other", modifiedText: "changed\n" });
    if (view.kind !== "delete-vs-modify") return;
    expect(view.explanation).toContain("deleted this note");
    expect(JSON.stringify(view)).not.toContain("Keep both");
  });

  it("gets the mirrored page when this device deleted the note", () => {
    const view = presentConflict(record({ observedLocal: undefined, snapshot: { baseAvailable: true, remote: "their text\n" } }));
    expect(view).toMatchObject({ kind: "delete-vs-modify", deletedSide: "current", modifiedText: "their text\n" });
  });
});

describe("what the user is allowed to read by default", () => {
  it("keeps markers, identities and raw sides out of everything but Technical details", () => {
    for (const fixture of [appended(), replaced(), incident(), whitespaceOnly()]) {
      const view = presentConflict(fixture);
      const readable = view.kind === "delete-vs-modify"
        ? JSON.stringify({ summary: view.summary, explanation: view.explanation, modifiedText: view.modifiedText })
        : JSON.stringify({ summary: view.summary, notice: (view as { notice?: string }).notice, label: (view as { label?: string }).label, suggestedText: (view as { suggestedText?: string }).suggestedText, draftText: (view as { draftText?: string }).draftText, differences: view.differences });
      expect(readable).not.toContain("<<<<<<<");
      expect(readable).not.toContain("=======");
      expect(readable).not.toContain(">>>>>>>");
      expect(readable).not.toContain("BASELINE-ETAG");
      expect(readable).not.toContain("REMOTE-ETAG");
      expect(readable).not.toContain("conflict-identity-1");
      expect(readable).not.toContain("Keep both");
    }
  });

  it("still holds every technical fact, including the raw marker draft", () => {
    const view = presentConflict(appended());
    const labels = view.technical.map((entry) => entry.label);
    expect(labels).toEqual(expect.arrayContaining(["Detected", "Conflict ID", "Remote ETag", "Auto merge", "Reason", "Base", "Raw current device", "Raw other version", "Raw merged draft"]));
    expect(view.technical.find((entry) => entry.label === "Raw merged draft")!.value).toContain("<<<<<<< LOCAL");
    expect(view.technical.find((entry) => entry.label === "Base")!.value).toBe("windows\nsf\n");
  });

  it("derives a combined addition from the shared head and tail only", () => {
    expect(combineAdditions("a\nb\n", "a\nc\n")).toBe("a\nb\nc\n");
    expect(combineAdditions("only-local\n", "only-other\n")).toBe("only-local\nonly-other\n");
    expect(combineAdditions("same\n", "same\n")).toBe("same\n");
  });
});
