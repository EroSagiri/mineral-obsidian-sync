import { describe, expect, it } from "vitest";
import { CONFLICT_PROTOCOL_VERSION, type ConflictRecord } from "../conflict/types";
import { keepBothText, presentConflict } from "./conflict-presentation";

/**
 * The resolver's view model. Presentation only: it runs the existing merge engine to recover the hunks
 * it already computes, and never re-decides whether something conflicts.
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

/** Both sides appended after the same shared lines — the case the UI exists to make easy. */
const appended = (): ConflictRecord => record({
  snapshot: {
    baseAvailable: true,
    base: "windows\nsf\n",
    local: "windows\nsf\nfrom windows\n",
    remote: "windows\nsf\noppo\n",
    draft: "windows\nsf\n<<<<<<< LOCAL\nfrom windows\n=======\noppo\n>>>>>>> REMOTE\n",
  },
});

/** The same lines replaced with different text on each side. */
const replaced = (): ConflictRecord => record({
  snapshot: { baseAvailable: true, base: "value = A\n", local: "value = B\n", remote: "value = C\n", draft: "value = B\n" },
});

/** The live incident: the other side added a trailing newline, this side added lines. */
const incident = (): ConflictRecord => record({
  snapshot: {
    baseAvailable: true,
    base: "windows\nwindows",
    local: "windows\nwindows\nandroid\nandroid\n",
    remote: "windows\nwindows\n",
    draft: "",
  },
});

describe("conflict presentation", () => {
  it("offers Keep both as the primary action when both sides only added text", () => {
    const view = presentConflict(appended());
    expect(view.headline).toBe("1 change needs your attention");
    expect(view.hunks).toHaveLength(1);
    expect(view.hunks[0]).toMatchObject({ insertBoth: true, title: "Both versions added content here:", currentHeading: "This device added", otherHeading: "Other version added" });
    expect(view.hunks[0]!.current).toBe("from windows\n");
    expect(view.hunks[0]!.other).toBe("oppo\n");
    // The preview a person can read, in the order they made the two edits.
    expect(view.keepBothText).toBe("windows\nsf\nfrom windows\noppo\n");
    expect(view.actions.map((action) => [action.label, action.primary])).toEqual([
      ["Keep both", true], ["Keep current device", false], ["Keep other version", false], ["Edit manually", false],
    ]);
    expect(view.actions[0]!.intent).toBe("merged");
  });

  it("names the two sides by role, never by transport direction", () => {
    const view = presentConflict(appended());
    expect(view.currentLabel).toBe("This device");
    expect(view.otherLabel).toBe("Other version");
    expect(view.hunks[0]!.currentHeading).not.toContain("Local");
    expect(view.hunks[0]!.otherHeading).not.toContain("Remote");
  });

  it("keeps a little shared context so the region can be located", () => {
    const view = presentConflict(appended());
    expect(view.hunks[0]!.contextBefore).toBe("windows\nsf\n");
    expect(view.hunks[0]!.contextAfter).toBe("");
  });

  it("does not offer Keep both when a region was replaced", () => {
    const view = presentConflict(replaced());
    expect(view.hunks[0]!.insertBoth).toBe(false);
    expect(view.hunks[0]!.title).toBe("Both versions changed this part:");
    expect(view.hunks[0]!.currentHeading).toBe("This device has");
    expect(view.keepBothText).toBeUndefined();
    expect(view.actions.map((action) => action.label)).not.toContain("Keep both");
    // With nothing lossless to offer, the safe default is to let the user write the result.
    expect(view.actions.find((action) => action.primary)!.label).toBe("Edit manually");
  });

  it("recognizes the live incident as an addition on both sides", () => {
    const view = presentConflict(incident());
    expect(view.hunks[0]!.insertBoth).toBe(true);
    expect(view.keepBothText).toBe("windows\nwindows\nandroid\nandroid\n");
    expect(view.actions.find((action) => action.label === "Keep both")!.primary).toBe(true);
  });

  it("never puts conflict markers in what the user reads by default", () => {
    for (const fixture of [appended(), replaced(), incident()]) {
      const view = presentConflict(fixture);
      const readable = [view.headline, view.notice ?? "", view.resultText, view.keepBothText ?? "", ...view.hunks.flatMap((hunk) => [hunk.title, hunk.currentHeading, hunk.otherHeading, hunk.contextBefore, hunk.contextAfter, hunk.current, hunk.other])].join("\n");
      expect(readable).not.toContain("<<<<<<<");
      expect(readable).not.toContain("=======");
      expect(readable).not.toContain(">>>>>>>");
      expect(readable).not.toContain("REMOTE");
    }
  });

  it("keeps every technical fact, including the raw marker draft, behind Technical details", () => {
    const view = presentConflict(record({
      snapshot: { baseAvailable: true, base: "value = A\n", local: "value = B\n", remote: "value = C\n", draft: "<<<<<<< LOCAL\nvalue = B\n=======\nvalue = C\n>>>>>>> REMOTE\n" },
    }));
    const labels = view.technical.map((entry) => entry.label);
    expect(labels).toEqual(expect.arrayContaining(["Detected", "Conflict ID", "Remote ETag", "Auto merge", "Reason", "Base (common ancestor)", "Raw current device", "Raw other version", "Raw merge draft"]));
    const draft = view.technical.find((entry) => entry.label === "Raw merge draft")!;
    expect(draft.value).toContain("<<<<<<< LOCAL");
    expect(view.technical.find((entry) => entry.label === "Conflict ID")!.value).toHaveLength(8);
    expect(view.technical.find((entry) => entry.label === "Base (common ancestor)")!.value).toBe("value = A\n");
  });

  it("explains a missing common ancestor instead of inventing one", () => {
    const view = presentConflict(record({ autoMergeStatus: "base-unavailable", snapshot: { baseAvailable: false, local: "local\n", remote: "remote\n" } }));
    expect(view.hunks).toEqual([]);
    expect(view.notice).toContain("common ancestor");
    expect(view.actions.map((action) => action.label)).toEqual(["Keep current device", "Keep other version", "Edit manually"]);
    expect(view.technical.find((entry) => entry.label === "Base (common ancestor)")!.value).toBe("not recorded");
  });

  it("offers deletion decisions, and no Keep both, when the other side deleted the file", () => {
    const view = presentConflict(record({
      observedRemoteDeletion: { path: "notes/a.md", deletedRemoteETag: "DELETED", createdAt: "2026-01-01T00:00:00.000Z", objectPresent: true },
      snapshot: { baseAvailable: true, local: "changed\n" },
    }));
    expect(view.hunks).toEqual([]);
    expect(view.keepBothText).toBeUndefined();
    expect(view.actions.map((action) => [action.label, action.intent])).toEqual([
      ["Keep this device's file", "keep-local"], ["Accept the deletion", "accept-remote-delete"],
    ]);
  });

  it("offers the restore decision, and no Keep both, when this device deleted the file", () => {
    const view = presentConflict(record({ observedLocal: undefined, snapshot: { baseAvailable: true, remote: "their text\n" } }));
    expect(view.resultText).toBe("their text\n");
    expect(view.actions.map((action) => [action.label, action.intent])).toEqual([
      ["Restore the other version", "keep-remote"], ["Accept the deletion", "accept-local-delete"],
    ]);
  });

  it("opens the manual editor with both sides present, so nothing has to be retyped", () => {
    expect(presentConflict(appended()).resultText).toBe("windows\nsf\nfrom windows\noppo\n");
    expect(presentConflict(replaced()).resultText).toBe("value = B\nvalue = C\n");
  });

  it("derives the both-sides text from the shared head and tail only", () => {
    expect(keepBothText("a\nb\n", "a\nc\n")).toBe("a\nb\nc\n");
    expect(keepBothText("only-local\n", "only-other\n")).toBe("only-local\nonly-other\n");
    // Identical sides collapse to one copy rather than being duplicated.
    expect(keepBothText("same\n", "same\n")).toBe("same\n");
  });
});
