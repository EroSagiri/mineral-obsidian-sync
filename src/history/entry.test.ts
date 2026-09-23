import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  describeHistoryEntry,
  describeHistoryEvidence,
  manualHistoryEntry,
  mergeHistoryEntry,
  newHistoryId,
  restoreHistoryEntry,
  snapshotOf,
} from "./entry";

/**
 * The builders are the only place a history entry is shaped, and the description text is the only
 * place a user reads what happened. Both are pinned here, including the snapshot hash: it must be the
 * repository's platform digest, so it is checked against known vectors and against node:crypto.
 */

const CHANNEL = "A".repeat(43);
const nodeSha256 = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

describe("snapshotOf", () => {
  it("produces a real SHA-256", async () => {
    expect((await snapshotOf("")).sha256).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect((await snapshotOf("abc")).sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("matches the platform digest at every block and padding boundary", async () => {
    for (const text of ["a", "é", "windows\nsf\n", "x".repeat(55), "x".repeat(56), "x".repeat(64), "é".repeat(1000), "line\n".repeat(200)]) {
      expect((await snapshotOf(text)).sha256, text.slice(0, 12)).toBe(nodeSha256(text));
    }
  });

  it("measures size in UTF-8 bytes, not characters", async () => {
    expect((await snapshotOf("")).size).toBe(0);
    expect((await snapshotOf("abc")).size).toBe(3);
    expect((await snapshotOf("é")).size).toBe(2);
    expect((await snapshotOf("windows\nsf\n")).size).toBe(11);
  });

  it("carries an etag and a modified time only when it was given one", async () => {
    expect(await snapshotOf("a\n")).not.toHaveProperty("etag");
    expect(await snapshotOf("a\n")).not.toHaveProperty("modified");
    const stamped = await snapshotOf("a\n", { etag: "ETAG-1", modified: 1_700_000_000_000 });
    expect(stamped.etag).toBe("ETAG-1");
    expect(stamped.modified).toBe(1_700_000_000_000);
  });
});

describe("newHistoryId", () => {
  it("has a stable shape and a readable timestamp prefix", () => {
    const now = 1_700_000_000_000;
    const id = newHistoryId(now);
    expect(id).toMatch(/^h[0-9a-z]+-[0-9a-z]{8}$/);
    expect(id.startsWith(`h${now.toString(36)}-`)).toBe(true);
  });

  it("stays unique across a millisecond and across a run", () => {
    // A deterministic walk of the unit interval, so a failing run can be reproduced.
    let seed = 1;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const ids = new Set<string>();
    for (let index = 0; index < 2000; index++) ids.add(newHistoryId(1_700_000_000_000, random));
    expect(ids.size).toBe(2000);
  });
});

describe("mergeHistoryEntry", () => {
  const input = async () => ({
    channel: CHANNEL,
    path: "notes/a.md",
    type: "clean-auto-merge" as const,
    timestamp: 1_700_000_000_000,
    base: await snapshotOf("windows\nsf\n"),
    localBefore: await snapshotOf("windows\nsf\nfrom windows\n", { modified: 1_700_000_000_000 }),
    remoteBefore: await snapshotOf("windows\nsf\noppo\n", { etag: "ETAG-REMOTE" }),
    result: "windows\nsf\nfrom windows\noppo\n",
    resultETag: "ETAG-RESULT",
    metadata: { localDeltaBytes: 84, hunkCount: 1, mergeReason: "one region", order: "stable-content" },
  });

  it("records the event, the snapshots and the landed result", async () => {
    const fixture = await input();
    const entry = await mergeHistoryEntry(fixture);
    expect(entry.type).toBe("clean-auto-merge");
    expect(entry.channel).toBe(CHANNEL);
    expect(entry.path).toBe("notes/a.md");
    expect(entry.timestamp).toBe(1_700_000_000_000);
    expect(entry.id).toMatch(/^h[0-9a-z]+-[0-9a-z]{8}$/);
    // The snapshots are the caller's own objects: the builder must not re-hash normalised text it
    // already has, and must not copy the (potentially large) content again.
    expect(entry.base).toBe(fixture.base);
    expect(entry.localBefore).toBe(fixture.localBefore);
    expect(entry.remoteBefore).toBe(fixture.remoteBefore);
    expect(entry.result.content).toBe("windows\nsf\nfrom windows\noppo\n");
    expect(entry.result.sha256).toHaveLength(64);
    expect(entry.result.size).toBe(Buffer.byteLength(entry.result.content, "utf8"));
    expect(entry.result.etag).toBe("ETAG-RESULT");
    expect(entry.metadata).toEqual({ localDeltaBytes: 84, hunkCount: 1, mergeReason: "one region", order: "stable-content" });
  });

  it("carries the handoff type and its evidence unchanged", async () => {
    const entry = await mergeHistoryEntry({ ...(await input()), type: "handoff-auto-merge", metadata: { branchSeparationMs: 6200, localDeltaBytes: 0, hunkCount: 1 } });
    expect(entry.type).toBe("handoff-auto-merge");
    expect(entry.metadata.branchSeparationMs).toBe(6200);
  });

  it("omits an absent ancestor and a caller-supplied id wins", async () => {
    const entry = await mergeHistoryEntry({ ...(await input()), base: undefined, resultETag: undefined, id: "fixed-id" });
    expect(entry.base).toBeUndefined();
    expect(entry.id).toBe("fixed-id");
    expect(entry.result).not.toHaveProperty("etag");
  });
});

describe("manualHistoryEntry", () => {
  it("derives its id from the conflict and records which resolution landed", async () => {
    const entry = await manualHistoryEntry({
      channel: CHANNEL,
      path: "notes/a.md",
      conflictId: "conflict-identity-1",
      timestamp: 1_700_000_000_000,
      resolutionType: "keep-local",
      localBefore: await snapshotOf("value = B\n"),
      remoteBefore: await snapshotOf("value = C\n"),
      result: "value = B\n",
      metadata: { hunkCount: 1 },
    });
    expect(entry.type).toBe("manual-conflict-resolved");
    expect(entry.id).toBe("manual-conflict-identity-1");
    expect(entry.metadata).toEqual({ hunkCount: 1, resolutionType: "keep-local" });
    expect(entry.result.content).toBe("value = B\n");
    expect(entry.result.size).toBe(10);
  });

  it("replaces its own record for the same conflict instead of duplicating it", async () => {
    const build = (timestamp: number) => manualHistoryEntry({
      channel: CHANNEL, path: "notes/a.md", conflictId: "conflict-identity-1", timestamp, resolutionType: "merged", result: "merged\n",
    });
    expect((await build(1)).id).toBe((await build(2)).id);
  });
});

describe("restoreHistoryEntry", () => {
  it("points at the source entry and keeps what it replaced", async () => {
    const previous = await snapshotOf("current before the restore\n", { modified: 1_700_000_000_000 });
    const entry = await restoreHistoryEntry({
      channel: CHANNEL,
      path: "notes/a.md",
      timestamp: 1_700_000_500_000,
      sourceHistoryId: "h1-abcdefgh",
      previousCurrent: previous,
      result: "windows\nsf\n",
      resultETag: "ETAG-NEW",
      metadata: { mergeReason: "user chose an earlier version" },
    });
    expect(entry.type).toBe("restore");
    expect(entry.metadata.sourceHistoryId).toBe("h1-abcdefgh");
    expect(entry.metadata.mergeReason).toBe("user chose an earlier version");
    expect(entry.previousCurrent).toBe(previous);
    expect(entry.result.content).toBe("windows\nsf\n");
    expect(entry.result.etag).toBe("ETAG-NEW");
    // A restore is a new event, so it never reuses the id of the entry it restored.
    expect(entry.id).not.toBe("h1-abcdefgh");
  });
});

describe("describeHistoryEntry", () => {
  const forType = async (type: "clean-auto-merge" | "handoff-auto-merge"): Promise<string> =>
    describeHistoryEntry(await mergeHistoryEntry({ channel: CHANNEL, path: "a.md", type, timestamp: 1, result: "a\n" }));

  it("uses one fixed sentence per event", async () => {
    expect(await forType("clean-auto-merge")).toBe("Auto-merged non-overlapping changes");
    expect(await forType("handoff-auto-merge")).toBe("Auto-merged a short device handoff");
    expect(describeHistoryEntry(await manualHistoryEntry({ channel: CHANNEL, path: "a.md", conflictId: "c1", timestamp: 1, resolutionType: "merged", result: "a\n" })))
      .toBe("Conflict resolved manually");
    expect(describeHistoryEntry(await restoreHistoryEntry({ channel: CHANNEL, path: "a.md", timestamp: 1, sourceHistoryId: "h1", previousCurrent: await snapshotOf("b\n"), result: "a\n" })))
      .toBe("Restored an earlier version");
  });
});

describe("describeHistoryEvidence", () => {
  const evidenceFor = async (metadata: Parameters<typeof mergeHistoryEntry>[0]["metadata"]): Promise<string | undefined> =>
    describeHistoryEvidence(await mergeHistoryEntry({ channel: CHANNEL, path: "a.md", type: "clean-auto-merge", timestamp: 1, result: "a\n", metadata }));

  it("renders only the facts that were recorded", async () => {
    expect(await evidenceFor({})).toBeUndefined();
    expect(await evidenceFor({ mergeReason: "one region", order: "stable-content" })).toBeUndefined();
    expect(await evidenceFor({ localDeltaBytes: 84 })).toBe("84 B added");
    expect(await evidenceFor({ localDeltaBytes: 40, remoteDeltaBytes: 44 })).toBe("84 B added");
    expect(await evidenceFor({ localDeltaBytes: -12 })).toBe("12 B removed");
    expect(await evidenceFor({ localDeltaBytes: 1536 })).toBe("1.5 kB added");
    expect(await evidenceFor({ hunkCount: 1 })).toBe("1 region");
    expect(await evidenceFor({ hunkCount: 3 })).toBe("3 regions");
  });

  it("reads a handoff as one line of scale and time", async () => {
    expect(await evidenceFor({ localDeltaBytes: 84, branchSeparationMs: 6200, hunkCount: 1 })).toBe("84 B added · 6.2s apart · 1 region");
  });

  it("rounds each separation to the unit that stays readable", async () => {
    expect(await evidenceFor({ branchSeparationMs: 500 })).toBe("500ms apart");
    expect(await evidenceFor({ branchSeparationMs: 45_000 })).toBe("45s apart");
    expect(await evidenceFor({ branchSeparationMs: 120_000 })).toBe("2m apart");
    expect(await evidenceFor({ branchSeparationMs: 7_200_000 })).toBe("2h apart");
  });

  it("falls back to the branch age when no separation was recorded", async () => {
    expect(await evidenceFor({ branchAgeMs: 3 * 24 * 60 * 60 * 1000 })).toBe("3d old");
    expect(await evidenceFor({ branchAgeMs: 5_000, branchSeparationMs: 6_200 })).toBe("6.2s apart");
  });

  it("never repeats a policy reason as if it were evidence of size", async () => {
    expect(await evidenceFor({ mergeReason: "the two versions differ only in formatting", order: "stable-content" })).toBeUndefined();
  });
});
