import { describe, expect, it } from "vitest";
import { SyncScheduler } from "./scheduler";
import { isRemoteObservationComplete } from "./scheduler";
import { FakeRemoteChange } from "../gateway/test-support";
import type { CycleDependencies, SchedulerTimers } from "./types";
import type { OperationResult } from "../sync/executor";
import type { SyncOperation } from "../sync/types";

class FakeTimers implements SchedulerTimers {
  private next = 1;
  readonly jobs = new Map<number, { delay: number; callback: () => void }>();
  set(delay: number, callback: () => void): unknown { const id = this.next++; this.jobs.set(id, { delay, callback }); return id; }
  clear(handle: unknown): void { this.jobs.delete(handle as number); }
  fire(delay?: number): void {
    const found = [...this.jobs.entries()].sort((a, b) => a[1].delay - b[1].delay).find(([, job]) => delay === undefined || job.delay === delay);
    if (!found) throw new Error(`No timer for ${delay ?? "next"}; pending=${JSON.stringify(this.delays())}`);
    this.jobs.delete(found[0]); found[1].callback();
  }
  delays(): number[] { return [...this.jobs.values()].map((job) => job.delay); }
}

const flush = async (): Promise<void> => { for (let index = 0; index < 32; index++) await Promise.resolve(); };
const upload = (key: string): SyncOperation => ({ type: "upload", key, reason: "test", expectedLocal: { key, size: 1, mtime: 1 }, expectedRemote: { kind: "absent" } });
const download = (key: string): SyncOperation => ({ type: "download", key, reason: "test", expectedLocal: { kind: "absent" }, expectedRemote: { key, size: 1, lastModified: 1, etag: "e" } });

const base = (operations: SyncOperation[], execute: CycleDependencies["execute"] = async (operation) => ({ status: "applied", key: operation.key })): CycleDependencies => ({
  scanLocal: () => new Map(), scanRemote: async () => new Map(), loadPrevious: async () => new Map(), filterPrevious: (entries) => entries,
  buildPlan: () => ({ operations }), execute,
});

interface Harness {
  scheduler: SyncScheduler;
  timers: FakeTimers;
  remote?: FakeRemoteChange;
  notify: number;
}

function setup(capture: () => CycleDependencies, withRemote = false): Harness {
  const timers = new FakeTimers();
  const remote = withRemote ? new FakeRemoteChange() : undefined;
  const scheduler = new SyncScheduler({ captureCycle: capture, visible: () => true, timers, remoteChange: remote });
  return { scheduler, timers, remote, get notify() { return remote?.notifyCalls ?? 0; } };
}

/** Runs one startup cycle to completion. */
async function runOnce(harness: Harness): Promise<void> {
  harness.scheduler.requestReconcile("startup");
  harness.timers.fire();
  await flush();
}

describe("writer notification coalescing", () => {
  it("sends exactly one Gateway notification for a cycle with several uploads and a download", async () => {
    const harness = setup(() => base([upload("a.md"), upload("b.md"), download("c.md")]), true);
    harness.remote!.script("10", "10");
    await runOnce(harness);
    // Three operations, three R2 effects at most, but the Hub is level-triggered: one wake-up.
    expect(harness.remote!.notifyCalls).toBe(1);
  });

  it("does not notify for downloads, noops, conflicts, blocked deletes, or stable failures", async () => {
    const cases: { name: string; operations: SyncOperation[]; execute: CycleDependencies["execute"] }[] = [
      { name: "download", operations: [download("c.md")], execute: async (operation) => ({ status: "applied", key: operation.key }) },
      { name: "noop", operations: [{ type: "noop", key: "a.md", reason: "test" }], execute: async () => ({ status: "failed", key: "x", error: "should not run" }) },
      { name: "conflict", operations: [{ type: "conflict", key: "a.md", conflict: "both-modified", reason: "test" }], execute: async () => ({ status: "failed", key: "x", error: "should not run" }) },
      { name: "blocked delete", operations: [{ type: "delete-remote", key: "a.md", reason: "test" }], execute: async (operation) => ({ status: "blocked", key: operation.key, reason: "deletion-not-supported-in-phase-2a" }) },
      { name: "stable upload failure", operations: [upload("a.md")], execute: async (operation) => ({ status: "failed", key: operation.key, error: "path", reason: "parent-path-is-file" }) },
      // Phase 4C.5: neither of these touches R2, so neither may wake other devices.
      { name: "baseline GC", operations: [{ type: "prune-baseline", key: "gone.md", reason: "test" }], execute: async (operation) => ({ status: "applied", key: operation.key }) },
      { name: "delete-local", operations: [{ type: "delete-local", key: "a.md", reason: "test", expectedLocal: { key: "a.md", size: 1, mtime: 1 } }], execute: async (operation) => ({ status: "applied", key: operation.key }) },
    ];
    for (const testCase of cases) {
      const harness = setup(() => base(testCase.operations, testCase.execute), true);
      await runOnce(harness);
      expect(harness.remote!.notifyCalls, testCase.name).toBe(0);
    }
  });

  it("notifies for resolutions that change R2, and not for keep-remote", async () => {
    const resolution = (type: "resolve-keep-local" | "resolve-keep-remote" | "resolve-merged"): SyncOperation =>
      type === "resolve-merged"
        ? { type, key: "a.md", reason: "test", conflictId: "c", expectedLocal: { key: "a.md", size: 1, mtime: 1 }, expectedRemoteETag: "R", merged: { content: "m\n", sha256: "s", encoding: { bom: false, eol: "lf", trailingNewline: true } } }
        : { type, key: "a.md", reason: "test", conflictId: "c", expectedLocal: { key: "a.md", size: 1, mtime: 1 }, expectedRemoteETag: "R" };
    const cases: Array<{ operation: SyncOperation; result: OperationResult; notify: number; name: string }> = [
      { name: "keep-local applied", operation: resolution("resolve-keep-local"), result: { status: "applied", key: "a.md" }, notify: 1 },
      { name: "merged applied", operation: resolution("resolve-merged"), result: { status: "applied", key: "a.md" }, notify: 1 },
      { name: "merged ambiguous PUT", operation: resolution("resolve-merged"), result: { status: "unresolved", key: "a.md", reason: "ambiguous-put" }, notify: 1 },
      // A partial resolution really did change R2, so other devices must still be woken.
      { name: "merged partial", operation: resolution("resolve-merged"), result: { status: "partial", key: "a.md", reason: "remote-applied-local-changed" }, notify: 1 },
      { name: "keep-local stale", operation: resolution("resolve-keep-local"), result: { status: "stale", key: "a.md", reason: "conflict-superseded" }, notify: 0 },
      // Keep-remote writes only the local file.
      { name: "keep-remote applied", operation: resolution("resolve-keep-remote"), result: { status: "applied", key: "a.md" }, notify: 0 },
    ];
    for (const testCase of cases) {
      const harness = setup(() => base([testCase.operation], async () => testCase.result), true);
      await runOnce(harness);
      expect(harness.remote!.notifyCalls, testCase.name).toBe(testCase.notify);
    }
  });

  it("still notifies when a cycle is stopped early after a confirmed R2 mutation", async () => {    // a.md succeeds, then a config change stops the cycle before b.md runs. a.md already changed R2,
    // so the exit notification must still happen.
    let scheduler!: SyncScheduler;
    const started: string[] = [];
    let fired = false;
    const harness = setup(() => base([upload("a.md"), upload("b.md")], async (operation) => {
      started.push(operation.key);
      if (!fired) { fired = true; scheduler.configChanged(); }
      return { status: "applied", key: operation.key };
    }), true);
    scheduler = harness.scheduler;
    await runOnce(harness);
    expect(started).toEqual(["a.md"]);
    expect(harness.remote!.notifyCalls).toBe(1);
  });

  it("treats an ambiguous PUT as a possible mutation and still reports unresolved", async () => {
    const harness = setup(() => base([upload("a.md")], async (operation): Promise<OperationResult> => ({ status: "unresolved", key: operation.key, reason: "ambiguous-put" })), true);
    await runOnce(harness);
    expect(harness.remote!.notifyCalls).toBe(1);
    expect(harness.scheduler.diagnostics().lastResultCounts.unresolved).toBe(1);
    // The executor's verdict is untouched: still unresolved, still no confirmation.
    expect(harness.remote!.confirmCalls).toEqual([]);
  });

  it("keeps the upload applied when the notification itself fails", async () => {
    const harness = setup(() => base([upload("a.md")]), true);
    harness.remote!.notifyFailure = "transport";
    harness.remote!.script("10", "10");
    await runOnce(harness);
    expect(harness.scheduler.diagnostics().lastResultCounts.applied).toBe(1);
    expect(harness.scheduler.diagnostics().lastFailureClass).toBeUndefined();
    // A failed notification does not produce a retry storm and does not advance the cursor.
    expect(harness.timers.delays()).toEqual([]);
    expect(harness.remote!.confirmCalls).toEqual([]);
  });
});

describe("generation handshake", () => {
  it("confirms the generation when the window closes unchanged", async () => {
    const harness = setup(() => base([upload("a.md")]), true);
    harness.remote!.announce("12");
    harness.remote!.script("12", "12");
    await runOnce(harness);
    expect(harness.remote!.confirmCalls).toEqual(["12"]);
    expect(harness.remote!.hasPending()).toBe(false);
    expect(harness.scheduler.diagnostics().lastConfirmation).toBe("confirmed");
  });

  it("does not lose G11 when the remote advances during the cycle (start=10, during=11, end=11)", async () => {
    const harness = setup(() => base([upload("a.md")]), true);
    harness.remote!.announce("10");
    // The opening read sees 10; a writer advances the Hub to 11 mid-cycle; the closing read sees 11.
    harness.remote!.script("10", "11");
    harness.remote!.announce("11");
    await runOnce(harness);
    // The window was NOT proven, so the cursor stays at its previous value and 11 remains pending.
    expect(harness.remote!.confirmCalls).toEqual([]);
    expect(harness.remote!.reconciled).toBe("0");
    expect(harness.remote!.hasPending()).toBe(true);
    expect(harness.scheduler.diagnostics().lastConfirmation).toBe("mismatch");
    // It is a remote-only window mismatch, so re-observe immediately rather than waiting for typing.
    expect(harness.timers.delays()).toEqual([0]);
  });

  it("covers the missed generation on the next cycle", async () => {
    const harness = setup(() => base([upload("a.md")]), true);
    harness.remote!.announce("11");
    harness.remote!.script("11", "11");
    await runOnce(harness);
    expect(harness.remote!.confirmCalls).toEqual(["11"]);
    expect(harness.remote!.hasPending()).toBe(false);
  });

  it("retains the cursor and backs off when the opening read fails", async () => {
    const harness = setup(() => base([upload("a.md")]), true);
    harness.remote!.announce("10");
    harness.remote!.readFailure = "server";
    await runOnce(harness);
    // The R2 work still happened: a Gateway outage is not a data-plane outage.
    expect(harness.scheduler.diagnostics().lastResultCounts.applied).toBe(1);
    expect(harness.remote!.confirmCalls).toEqual([]);
    expect(harness.scheduler.diagnostics().lastConfirmation).toBe("start-unavailable");
    expect(harness.scheduler.diagnostics().lastFailureClass).toBe("retryable");
    // Bounded backoff, not a busy loop.
    expect(harness.timers.delays()).toEqual([5000]);
  });

  it("retains the cursor and backs off when the closing read fails", async () => {
    let reads = 0;
    const harness = setup(() => base([upload("a.md")]), true);
    harness.remote!.announce("10");
    const remote = harness.remote!;
    remote.readGeneration = async () => { reads++; return reads === 1 ? { ok: true, generation: "10" } : { ok: false, kind: "transport" }; };
    await runOnce(harness);
    expect(harness.scheduler.diagnostics().lastResultCounts.applied).toBe(1);
    expect(harness.remote!.confirmCalls).toEqual([]);
    expect(harness.scheduler.diagnostics().lastConfirmation).toBe("notify-failed");
    expect(harness.timers.delays()).toEqual([5000]);
  });

  it("still reconciles R2 fully while the Gateway is unavailable", async () => {
    let scanned = 0;
    const harness = setup(() => ({ ...base([upload("a.md")]), scanRemote: async () => { scanned++; return new Map(); } }), true);
    harness.remote!.announce("3");
    harness.remote!.readFailure = "auth";
    await runOnce(harness);
    expect(scanned).toBe(1);
    expect(harness.scheduler.diagnostics().lastResultCounts.applied).toBe(1);
  });

  it("does not pay a handshake round trip for a local-only cycle with nothing pending", async () => {
    const harness = setup(() => base([upload("a.md")]), true);
    harness.remote!.readFailure = "server";
    harness.scheduler.markLocalPaths(["a.md"], () => false);
    harness.timers.fire(1200);
    await flush();
    expect(harness.remote!.confirmCalls).toEqual([]);
    expect(harness.scheduler.diagnostics().lastConfirmation).toBe("not-requested");
    expect(harness.timers.delays()).toEqual([]);
  });

  it("carries the handshake on an ordinary local cycle when a remote generation is already pending", async () => {
    const harness = setup(() => base([upload("a.md")]), true);
    harness.remote!.announce("9");
    harness.remote!.script("9", "9");
    harness.scheduler.markLocalPaths(["a.md"], () => false);
    harness.timers.fire(1200);
    await flush();
    // The pending remote window was absorbed by the cycle that was going to run anyway.
    expect(harness.remote!.confirmCalls).toEqual(["9"]);
    expect(harness.remote!.hasPending()).toBe(false);
  });

  it("keeps a remote generation that arrives mid-cycle pending for a follow-up", async () => {
    let announced = false;
    const harness = setup(() => ({ ...base([upload("a.md")]), scanRemote: async () => { if (!announced) { announced = true; harness.remote!.announce("11"); } return new Map(); } }), true);
    harness.remote!.announce("10");
    harness.remote!.script("10", "11");
    await runOnce(harness);
    expect(harness.remote!.confirmCalls).toEqual([]);
    expect(harness.remote!.hasPending()).toBe(true);
  });
});

describe("remote observation completeness", () => {
  const counts = (partial: Partial<Record<string, number>>): Parameters<typeof isRemoteObservationComplete>[0]["counts"] => ({ applied: 0, stale: 0, failed: 0, unresolved: 0, blocked: 0, conflict: 0, noop: 0, ...partial } as never);

  it("treats conflict and blocked as complete, and stale/unresolved/partial/halted as incomplete", () => {
    expect(isRemoteObservationComplete({ counts: counts({ conflict: 2 }), stale: false, halted: false })).toBe(true);
    expect(isRemoteObservationComplete({ counts: counts({ blocked: 3 }), stale: false, halted: false })).toBe(true);
    expect(isRemoteObservationComplete({ counts: counts({ failed: 1, reason: undefined } as never), stale: false, halted: false })).toBe(true);
    expect(isRemoteObservationComplete({ counts: counts({ applied: 5, noop: 5 }), stale: false, halted: false })).toBe(true);
    expect(isRemoteObservationComplete({ counts: counts({ stale: 1 }), stale: true, halted: false })).toBe(false);
    expect(isRemoteObservationComplete({ counts: counts({ unresolved: 1 }), stale: false, halted: false })).toBe(false);
    expect(isRemoteObservationComplete({ counts: counts({ partial: 1 }), stale: false, halted: false })).toBe(false);
    expect(isRemoteObservationComplete({ counts: counts({ applied: 5 }), stale: false, halted: true })).toBe(false);
  });

  it("confirms the generation for a conflict window and does not re-run it", async () => {
    const harness = setup(() => base([{ type: "conflict", key: "a.md", conflict: "both-modified", reason: "test" }]), true);
    harness.remote!.announce("5");
    harness.remote!.script("5", "5");
    await runOnce(harness);
    expect(harness.remote!.confirmCalls).toEqual(["5"]);
    expect(harness.remote!.hasPending()).toBe(false);
    // The same generation must not cause an endless immediate rerun.
    expect(harness.timers.delays()).toEqual([]);
  });

  it("confirms the generation for a blocked-delete window and does not re-run it", async () => {
    const harness = setup(() => base([{ type: "delete-remote", key: "a.md", reason: "test" }], async (operation) => ({ status: "blocked", key: operation.key, reason: "deletion-not-supported-in-phase-2a" })), true);
    harness.remote!.announce("6");
    harness.remote!.script("6", "6");
    await runOnce(harness);
    expect(harness.remote!.confirmCalls).toEqual(["6"]);
    expect(harness.remote!.hasPending()).toBe(false);
    expect(harness.timers.delays()).toEqual([]);
  });

  it("treats a cycle stopped by a config change as an unproven window", async () => {
    let scheduler!: SyncScheduler;
    const harness = setup(() => base([upload("a.md")], async (operation) => { scheduler.configChanged(); return { status: "applied", key: operation.key }; }), true);
    scheduler = harness.scheduler;
    harness.remote!.announce("4");
    await runOnce(harness);
    expect(harness.remote!.confirmCalls).toEqual([]);
    expect(harness.remote!.hasPending()).toBe(true);
  });

  it("treats a cycle stopped by unload as an unproven window", async () => {
    let scheduler!: SyncScheduler;
    const harness = setup(() => base([upload("a.md")], async (operation) => { scheduler.stop(); return { status: "applied", key: operation.key }; }), true);
    scheduler = harness.scheduler;
    harness.remote!.announce("4");
    await runOnce(harness);
    expect(harness.remote!.confirmCalls).toEqual([]);
  });
});

describe("remote-change triggering", () => {
  it("coalesces a burst of announcements into one cycle", async () => {
    let cycles = 0;
    const harness = setup(() => { cycles++; return base([]); }, true);
    harness.remote!.announce("1");
    harness.scheduler.requestReconcile("remote-change");
    harness.remote!.announce("2");
    harness.scheduler.requestReconcile("remote-change");
    harness.remote!.announce("3");
    harness.scheduler.requestReconcile("remote-change");
    expect(cycles).toBe(0);
    expect(harness.timers.delays()).toEqual([0]);
    harness.timers.fire(0);
    await flush();
    expect(cycles).toBe(1);
  });

  it("never starts a concurrent cycle when an announcement arrives mid-flight", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let cycles = 0;
    const harness = setup(() => ({ ...base([]), scanRemote: async () => { cycles++; await wait; return new Map(); } }), true);
    harness.scheduler.requestReconcile("remote-change");
    harness.timers.fire();
    await flush();
    harness.remote!.announce("7");
    harness.scheduler.requestReconcile("remote-change");
    // No second cycle, and no timer is armed while the first one is still running.
    expect(cycles).toBe(1);
    expect(harness.timers.delays()).toEqual([]);
    release();
    await flush();
    expect(cycles).toBe(1);
    expect(harness.timers.delays()).toEqual([0]);
    harness.timers.fire(0);
    await flush();
    expect(cycles).toBe(2);
  });

  it("makes no remote request at all when the control plane is absent", async () => {
    const harness = setup(() => base([upload("a.md")]), false);
    await runOnce(harness);
    expect(harness.remote).toBeUndefined();
    expect(harness.scheduler.diagnostics().lastResultCounts.applied).toBe(1);
  });
});

describe("conflict observation hook", () => {
  it("reports an empty conflict list, so a resolved conflict can be dropped", async () => {
    // The empty call is load-bearing: without it the coordinator would keep a stale conflict visible
    // forever, because a key that stops conflicting produces no conflict operation at all.
    const observed: Array<Array<{ key: string }>> = [];
    const timers = new FakeTimers();
    const scheduler = new SyncScheduler({
      captureCycle: () => base([]),
      visible: () => true,
      timers,
      onConflicts: async (conflicts) => { observed.push(conflicts as Array<{ key: string }>); },
    });
    scheduler.requestReconcile("startup");
    timers.fire();
    await flush();
    expect(observed).toEqual([[]]);
  });

  it("passes the conflicted keys once per cycle", async () => {
    const observed: Array<Array<{ key: string }>> = [];
    const timers = new FakeTimers();
    const scheduler = new SyncScheduler({
      captureCycle: () => ({ ...base([{ type: "conflict", key: "a.md", conflict: "both-modified", reason: "test" }]), observeConflicts: (conflicts) => conflicts.map((conflict) => ({ key: conflict.key })) }),
      visible: () => true,
      timers,
      onConflicts: async (conflicts) => { observed.push(conflicts as Array<{ key: string }>); },
    });
    scheduler.requestReconcile("startup");
    timers.fire();
    await flush();
    expect(observed).toEqual([[{ key: "a.md" }]]);
  });

  it("keeps the cycle result intact when conflict handling throws", async () => {
    const timers = new FakeTimers();
    const scheduler = new SyncScheduler({
      captureCycle: () => base([upload("a.md")]),
      visible: () => true,
      timers,
      onConflicts: async () => { throw new Error("coordinator unavailable"); },
    });
    scheduler.requestReconcile("startup");
    timers.fire();
    await flush();
    // A broken conflict coordinator must never degrade an otherwise successful cycle.
    expect(scheduler.diagnostics().lastResultCounts.applied).toBe(1);
    expect(scheduler.diagnostics().lastFailureClass).toBeUndefined();
  });
});
