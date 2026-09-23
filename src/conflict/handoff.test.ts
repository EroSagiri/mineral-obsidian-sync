import { describe, expect, it } from "vitest";
import { HANDOFF_MAX_DELTA_BYTES, HANDOFF_MAX_SEPARATION_MS, classifyDivergence, type DivergenceInput } from "./handoff";

/**
 * The divergence policy, pinned case by case.
 *
 * The shape under test is "a laptop closed mid-sentence and a phone picked it up" against "a branch
 * that drifted for days": the first is settled silently and losslessly, the second is handed to the
 * user. Every `manual` expectation here is a case the policy is deliberately *not* willing to guess at.
 */

const T0 = 1_700_000_000_000;
const input = (overrides: Partial<DivergenceInput>): DivergenceInput => ({
  base: "windows\nsf\n",
  local: "windows\nsf\nfrom windows\n",
  remote: "windows\nsf\noppo\n",
  localChangedAt: T0,
  remoteChangedAt: T0 + 5_000,
  baseSyncedAt: T0 - 60_000,
  ...overrides,
});

describe("level 0: clean", () => {
  it("settles non-overlapping edits with no time or size condition at all", () => {
    const decision = classifyDivergence({
      base: "h1\nh2\nh3\n",
      local: "h1\nX\nh2\nh3\n",
      remote: "h1\nh2\nh3\nY\n",
      // Deliberately absent: a clean merge does not consult time.
    });
    expect(decision.class).toBe("clean");
    expect(decision.mergedText).toBe("h1\nX\nh2\nh3\nY\n");
  });

  it("treats a formatting-only difference as no disagreement", () => {
    const decision = classifyDivergence(input({ base: "a\nb\n", local: "a\nb \n", remote: "a\nb\t\n" }));
    expect(decision.class).toBe("clean");
    expect(decision.reason).toContain("formatting");
  });

  it("does not count a trailing newline as an addition", () => {
    // The live incident: the other side only added a final newline.
    const decision = classifyDivergence(input({ base: "windows\nwindows", local: "windows\nwindows\nandroid\n", remote: "windows\nwindows\n" }));
    expect(decision.class).toBe("clean");
    expect(decision.mergedText).toBe("windows\nwindows\nandroid\n");
    expect(decision.stats!.insertedBytes).toBeLessThan(HANDOFF_MAX_DELTA_BYTES);
  });

  it("ignores CRLF against LF", () => {
    expect(classifyDivergence(input({ base: "a\r\nb\r\n", local: "a\nb\nnew\n", remote: "a\r\nb\r\n" })).class).toBe("clean");
  });
});

describe("level 1: handoff", () => {
  it("auto-merges a small insertion on both sides five seconds apart", () => {
    const decision = classifyDivergence(input({}));
    expect(decision.class).toBe("handoff");
    expect(decision.branchSeparationMs).toBe(5_000);
    expect(decision.stats).toEqual({ insertedBytes: 18, deletedBytes: 0, replacedBytes: 0, hunkCount: 1 });
  });

  it("auto-merges two appends at the end of the file twenty seconds apart", () => {
    const decision = classifyDivergence(input({
      base: "note\n",
      local: "note\npc line\n",
      remote: "note\nphone line\n",
      localChangedAt: T0,
      remoteChangedAt: T0 + 20_000,
    }));
    expect(decision.class).toBe("handoff");
    expect(decision.mergedText).toBe("note\npc line\nphone line\n");
    expect(decision.order).toBe("local-first");
  });

  it("keeps both sides even when the order cannot be decided", () => {
    const decision = classifyDivergence(input({ localChangedAt: T0, remoteChangedAt: T0 + 120 }));
    expect(decision.class).toBe("handoff");
    expect(decision.order).toBe("deterministic");
    expect(decision.reason).toContain("too close");
    // Both additions survive, whichever way round they are written.
    expect(decision.mergedText).toContain("from windows");
    expect(decision.mergedText).toContain("oppo");
  });

  it("puts the earlier branch first when the times can be told apart", () => {
    const earlier = classifyDivergence(input({ localChangedAt: T0 + 7_000, remoteChangedAt: T0 }));
    expect(earlier.class).toBe("handoff");
    expect(earlier.order).toBe("remote-first");
    expect(earlier.mergedText).toBe("windows\nsf\noppo\nfrom windows\n");
  });

  it("reports the age of the branch without gating on it", () => {
    const decision = classifyDivergence(input({ baseSyncedAt: T0 - 3 * 24 * 60 * 60 * 1000 }));
    expect(decision.class).toBe("handoff");
    expect(decision.branchAgeMs).toBe(3 * 24 * 60 * 60 * 1000 + 5_000);
  });
});

describe("level 2: manual", () => {
  it("refuses a replacement on both sides, however close in time", () => {
    const decision = classifyDivergence(input({ base: "value = A\n", local: "value = B\n", remote: "value = C\n" }));
    expect(decision.class).toBe("manual");
    expect(decision.reason).toContain("replaced or removed");
  });

  it("refuses a modification against a deletion", () => {
    const decision = classifyDivergence(input({ base: "keep\nremove me\n", local: "keep\nCHANGED me\n", remote: "keep\n" }));
    expect(decision.class).toBe("manual");
  });

  it("refuses an addition that is too large to be a handoff", () => {
    const big = "x".repeat(HANDOFF_MAX_DELTA_BYTES + 1);
    const decision = classifyDivergence(input({ base: "a\n", local: `a\n${big}\n`, remote: "a\nother\n" }));
    expect(decision.class).toBe("manual");
    expect(decision.reason).toContain("more than a handoff");
  });

  it("refuses branches written further apart than a handoff", () => {
    const decision = classifyDivergence(input({ localChangedAt: T0, remoteChangedAt: T0 + HANDOFF_MAX_SEPARATION_MS + 1 }));
    expect(decision.class).toBe("manual");
    expect(decision.reason).toContain("longer than a handoff");
  });

  it("refuses when the times are missing or unusable rather than assuming a handoff", () => {
    for (const times of [{ localChangedAt: undefined }, { remoteChangedAt: undefined }, { localChangedAt: 0 }, { remoteChangedAt: Number.NaN }]) {
      const decision = classifyDivergence(input(times));
      expect(decision.class, JSON.stringify(times)).toBe("manual");
      expect(decision.reason).toContain("times are missing");
    }
  });

  it("refuses without a recorded common ancestor", () => {
    const decision = classifyDivergence(input({ base: undefined }));
    expect(decision.class).toBe("manual");
    expect(decision.reason).toContain("no common ancestor");
  });

  it("refuses an edit elsewhere in the file, because the additions are then not the whole story", () => {
    // Both sides add the same small thing, but this device also rewrote the first line.
    const decision = classifyDivergence(input({ base: "one\ntwo\n", local: "ONE\ntwo\nmine\n", remote: "one\ntwo\ntheirs\n" }));
    expect(decision.class).toBe("manual");
  });

  it("refuses more disagreeing regions than one", () => {
    // Two separate one-line regions where each side inserted different text on the same lines.
    const base = "a\nb\n";
    const local = "a-mine\nb-mine\n";
    const remote = "a-theirs\nb-theirs\n";
    const decision = classifyDivergence(input({ base, local, remote }));
    expect(decision.class).toBe("manual");
  });

  it("never returns a partial result: a manual verdict carries no text to apply", () => {
    for (const fixture of [
      input({ base: "value = A\n", local: "value = B\n", remote: "value = C\n" }),
      input({ remoteChangedAt: T0 + HANDOFF_MAX_SEPARATION_MS + 1 }),
      input({ base: undefined }),
    ]) {
      const decision = classifyDivergence(fixture);
      expect(decision.class).toBe("manual");
      expect(decision.mergedText).toBeUndefined();
    }
  });
});
