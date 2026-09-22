import { describe, expect, it } from "vitest";
import { flushAction, isOwnWrite, writeChangedFile } from "./android-editor-save";

/**
 * The two invariants that keep an Android editor buffer from being stranded, and the one that keeps a
 * no-op save from costing a cycle.
 */
describe("android editor save decisions", () => {
  it("never discards an owed save while the app is not in the foreground", () => {
    // The reason this matters: the buffer is invisible to every file-level trigger, so a dropped save
    // is not retried by anything else and only a new keystroke can recover it.
    expect(flushAction({ hidden: true, hasView: true })).toBe("retry-later");
    expect(flushAction({ hidden: true, hasView: false })).toBe("retry-later");
  });

  it("saves an owed buffer when the app is going away", () => {
    expect(flushAction({ hidden: true, hasView: true, force: true })).toBe("save");
  });

  it("saves whenever a view still holds the path", () => {
    expect(flushAction({ hidden: false, hasView: true })).toBe("save");
  });

  it("falls back to marking the path when no view holds it", () => {
    // The buffer died with the view, so the only useful action left is to make a cycle re-read the file.
    expect(flushAction({ hidden: false, hasView: false })).toBe("mark-only");
  });

  it("reports a write only when the file's version actually moved", () => {
    expect(writeChangedFile({ size: 10, mtime: 5 }, { size: 10, mtime: 5 })).toBe(false);
    expect(writeChangedFile({ size: 10, mtime: 5 }, { size: 11, mtime: 5 })).toBe(true);
    expect(writeChangedFile({ size: 10, mtime: 5 }, { size: 10, mtime: 6 })).toBe(true);
  });

  it("assumes a change when a version could not be observed", () => {
    expect(writeChangedFile(null, { size: 10, mtime: 5 })).toBe(true);
    expect(writeChangedFile({ size: 10, mtime: 5 }, null)).toBe(true);
  });

  it("recognises its own write by version, not by timing", () => {
    expect(isOwnWrite({ size: 10, mtime: 5 }, { size: 10, mtime: 5 })).toBe(true);
    expect(isOwnWrite({ size: 10, mtime: 5 }, { size: 10, mtime: 6 })).toBe(false);
    expect(isOwnWrite({ size: 10, mtime: 5 }, { size: 12, mtime: 5 })).toBe(false);
    expect(isOwnWrite(undefined, { size: 10, mtime: 5 })).toBe(false);
    expect(isOwnWrite({ size: 10, mtime: 5 }, null)).toBe(false);
  });
});
