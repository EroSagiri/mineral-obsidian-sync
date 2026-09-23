import { describe, expect, it } from "vitest";
import { SYNC_HISTORY_MAX_ENTRIES, SYNC_HISTORY_RETENTION_DAYS, expiredHistoryIds } from "./retention";

/**
 * Retention is the only thing standing between a long-lived vault and an unbounded local database, so
 * these cases pin the two limits, their boundary, and the determinism the store's deletes rely on.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const at = (agoMs: number): number => NOW - agoMs;
const entry = (id: string, timestamp: number): { id: string; timestamp: number } => ({ id, timestamp });

describe("age limit", () => {
  it("expires entries older than the retention window", () => {
    const expired = expiredHistoryIds([entry("fresh", at(60 * 60 * 1000)), entry("old", at(31 * DAY))], NOW);
    expect(expired).toEqual(["old"]);
  });

  it("keeps an entry sitting exactly on the cutoff", () => {
    const cutoff = at(SYNC_HISTORY_RETENTION_DAYS * DAY);
    expect(expiredHistoryIds([entry("boundary", cutoff)], NOW)).toEqual([]);
    expect(expiredHistoryIds([entry("just-past", cutoff - 1)], NOW)).toEqual(["just-past"]);
  });
});

describe("count limit", () => {
  const many = (count: number): Array<{ id: string; timestamp: number }> =>
    Array.from({ length: count }, (_unused, index) => entry(`e${index.toString().padStart(3, "0")}`, at(index)));

  it("expires everything beyond the newest entries", () => {
    const entries = many(SYNC_HISTORY_MAX_ENTRIES + 5);
    const expired = expiredHistoryIds(entries, NOW);
    expect(expired).toEqual(["e500", "e501", "e502", "e503", "e504"]);
  });

  it("keeps exactly the newest entries", () => {
    const entries = many(SYNC_HISTORY_MAX_ENTRIES + 5);
    const expired = new Set(expiredHistoryIds(entries, NOW));
    for (const kept of entries.slice(0, SYNC_HISTORY_MAX_ENTRIES)) expect(expired.has(kept.id), kept.id).toBe(false);
  });

  it("breaks a timestamp tie by id, so the retained set never depends on input order", () => {
    // One millisecond shared by 501 entries: the count limit alone decides, and only the comparator can.
    const tied = Array.from({ length: SYNC_HISTORY_MAX_ENTRIES + 1 }, (_unused, index) => entry(`a${index.toString().padStart(3, "0")}`, NOW));
    expect(expiredHistoryIds(tied, NOW)).toEqual(["a500"]);
    expect(expiredHistoryIds([...tied].reverse(), NOW)).toEqual(["a500"]);
  });
});

describe("determinism", () => {
  it("returns the same ids for any permutation of the same entries", () => {
    const entries = [
      entry("old", at(40 * DAY)),
      entry("ancient", at(90 * DAY)),
      ...Array.from({ length: SYNC_HISTORY_MAX_ENTRIES + 2 }, (_unused, index) => entry(`f${index.toString().padStart(3, "0")}`, at(index + 1))),
    ];
    const forward = expiredHistoryIds(entries, NOW);
    const reverse = expiredHistoryIds([...entries].reverse(), NOW);
    expect(forward).toEqual(reverse);
    expect(forward).toContain("old");
    expect(forward).toContain("ancient");
  });

  it("applies both limits together", () => {
    const entries = [
      ...Array.from({ length: SYNC_HISTORY_MAX_ENTRIES + 1 }, (_unused, index) => entry(`f${index.toString().padStart(3, "0")}`, at(index))),
      entry("old-40d", at(40 * DAY)),
      entry("old-41d", at(41 * DAY)),
    ];
    // The oldest fresh entry falls out of the count window, and both old entries out of the age window.
    expect(expiredHistoryIds(entries, NOW)).toEqual(["f500", "old-40d", "old-41d"]);
  });
});

describe("nothing to do", () => {
  it("expires nothing when the history is small and fresh", () => {
    expect(expiredHistoryIds([], NOW)).toEqual([]);
    expect(expiredHistoryIds([entry("a", at(0)), entry("b", at(1000)), entry("c", at(29 * DAY))], NOW)).toEqual([]);
  });
});
