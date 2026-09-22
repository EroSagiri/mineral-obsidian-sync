import { describe, expect, it } from "vitest";
import { changedLocalKeys } from "./mobile-local-drift";
import type { LocalEntry } from "../sync/types";

const entry = (key: string, size: number, mtime: number): LocalEntry => ({ key, size, mtime });

describe("changedLocalKeys", () => {
  it("reports creations, metadata changes, and removals without reporting unchanged entries", () => {
    const previous = new Map([
      ["same.md", entry("same.md", 1, 10)],
      ["changed.md", entry("changed.md", 1, 10)],
      ["deleted.md", entry("deleted.md", 1, 10)],
    ]);
    const current = new Map([
      ["same.md", entry("same.md", 1, 10)],
      ["changed.md", entry("changed.md", 2, 11)],
      ["created.md", entry("created.md", 1, 12)],
    ]);

    expect(changedLocalKeys(previous, current).sort()).toEqual(["changed.md", "created.md", "deleted.md"]);
  });

  it("returns no keys for equal snapshots", () => {
    const snapshot = new Map([["note.md", entry("note.md", 5, 100)]]);
    expect(changedLocalKeys(snapshot, new Map(snapshot))).toEqual([]);
  });
});
