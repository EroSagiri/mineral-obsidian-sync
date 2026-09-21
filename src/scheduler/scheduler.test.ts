import { describe, expect, it } from "vitest";
import { SyncScheduler } from "./scheduler";
import type { CycleDependencies, SchedulerTimers } from "./types";
import type { SyncOperation } from "../sync/types";

class FakeTimers implements SchedulerTimers {
  private next = 1;
  readonly jobs = new Map<number, { delay: number; callback: () => void }>();
  set(delay: number, callback: () => void): unknown { const id = this.next++; this.jobs.set(id, { delay, callback }); return id; }
  clear(handle: unknown): void { this.jobs.delete(handle as number); }
  fire(delay?: number): void {
    const found = [...this.jobs.entries()].sort((a, b) => a[1].delay - b[1].delay).find(([, job]) => delay === undefined || job.delay === delay);
    if (!found) throw new Error(`No timer for ${delay ?? "next"}`);
    this.jobs.delete(found[0]); found[1].callback();
  }
  delays(): number[] { return [...this.jobs.values()].map((job) => job.delay); }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const upload = (key: string): SyncOperation => ({ type: "upload", key, reason: "test", expectedLocal: { key, size: 1, mtime: 1 }, expectedRemote: { kind: "absent" } });
const base = (operations: SyncOperation[], execute: CycleDependencies["execute"] = async (operation) => ({ status: "applied", key: operation.key })): CycleDependencies => ({
  scanLocal: () => new Map(), scanRemote: async () => new Map(), loadPrevious: async () => new Map(), filterPrevious: (entries) => entries,
  buildPlan: () => ({ operations }), execute,
});
function setup(capture: () => CycleDependencies) {
  const timers = new FakeTimers(); let visible = true;
  const scheduler = new SyncScheduler({ captureCycle: capture, visible: () => visible, timers });
  return { scheduler, timers, hide: () => { visible = false; scheduler.visibilityChanged(false); }, show: () => { visible = true; scheduler.visibilityChanged(true); } };
}

describe("SyncScheduler", () => {
  it("uses one trailing global debounce for repeated and burst local events", async () => {
    let cycles = 0; const { scheduler, timers } = setup(() => { cycles++; return base([]); });
    scheduler.markLocalPaths(["a.md"], () => false); scheduler.markLocalPaths(["a.md"], () => false);
    for (let i = 0; i < 100; i++) scheduler.markLocalPaths([`burst/${i}.md`], () => false);
    expect(cycles).toBe(0); expect(timers.delays()).toEqual([1200]);
    timers.fire(1200); await flush(); expect(cycles).toBe(1); expect(scheduler.diagnostics().syncDirtyVersion).toBe(102);
  });

  it("keeps cycles single-flight and coalesces events during an active scan", async () => {
    let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); let cycles = 0;
    const { scheduler, timers } = setup(() => ({ ...base([]), scanRemote: async () => { cycles++; await wait; return new Map(); } }));
    scheduler.markLocalPaths(["a.md"], () => false); timers.fire(); await flush();
    scheduler.markLocalPaths(["b.md"], () => false); scheduler.markLocalPaths(["c.md"], () => false);
    expect(timers.delays()).toEqual([]); release(); await flush();
    expect(cycles).toBe(1); expect(timers.delays()).toEqual([1200]); timers.fire(1200); await flush(); expect(cycles).toBe(2);
  });

  it("does version-aware dirty pruning and never reruns for ignored events", async () => {
    let cycle = 0; const { scheduler, timers } = setup(() => ({ ...base([]), scanRemote: async () => { cycle++; if (cycle === 1) scheduler.markLocalPaths(["new.md"], () => false); return new Map(); } }));
    scheduler.markLocalPaths(["old.md"], () => false); timers.fire(); await flush();
    expect(scheduler.diagnostics().pendingDirtyCount).toBe(1); expect(timers.delays()).toEqual([1200]);
    scheduler.markLocalPaths(["ignored.tmp"], () => true); expect(scheduler.diagnostics().syncDirtyVersion).toBe(2);
    timers.fire(); await flush(); expect(scheduler.diagnostics().pendingDirtyCount).toBe(0);
  });

  it("accepts self-write events and converges through one follow-up full cycle", async () => {
    let cycle = 0; let scheduler!: SyncScheduler;
    const env = setup(() => base(cycle++ === 0 ? [upload("remote.md")] : [], async (operation) => { scheduler.markLocalPaths([operation.key], () => false); return { status: "applied", key: operation.key }; })); scheduler = env.scheduler;
    scheduler.requestReconcile("startup"); env.timers.fire(1200); await flush();
    expect(env.timers.delays()).toEqual([1200]); env.timers.fire(1200); await flush(); expect(cycle).toBe(2);
  });

  it("uses immediate stale replan only without local dirtiness", async () => {
    let cycle = 0; const { scheduler, timers } = setup(() => base(cycle++ === 0 ? [upload("a.md")] : [], async (operation) => ({ status: "stale", key: operation.key, reason: "local-changed" })));
    scheduler.requestReconcile("startup"); timers.fire(); await flush(); expect(timers.delays()).toEqual([0]); timers.fire(0); await flush(); expect(cycle).toBe(2);
    const withDirty = setup(() => base([upload("b.md")], async (operation) => { withDirty.scheduler.markLocalPaths(["typing.md"], () => false); return { status: "stale", key: operation.key, reason: "local-changed" }; }));
    withDirty.scheduler.requestReconcile("startup"); withDirty.timers.fire(); await flush(); expect(withDirty.timers.delays()).toEqual([1200]);
  });

  it("stops an old plan after config or ignore-policy generation changes while an operation is in flight", async () => {
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; }); const started: string[] = [];
    const { scheduler, timers } = setup(() => base([upload("private/a.md"), upload("private/b.md"), upload("private/c.md")], async (operation) => { started.push(operation.key); if (operation.key === "private/b.md") await pending; return { status: "applied", key: operation.key }; }));
    scheduler.requestReconcile("startup"); timers.fire(); await flush(); expect(started).toEqual(["private/a.md", "private/b.md"]);
    // The main integration invokes this after persisted ignoredPaths changes too.
    scheduler.configChanged(); release(); await flush(); expect(started).toEqual(["private/a.md", "private/b.md"]); expect(timers.delays()).toEqual([400]);
  });

  it("stops at an operation boundary when hidden and resumes with a full cycle", async () => {
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; }); const started: string[] = [];
    const env = setup(() => base([upload("a.md"), upload("b.md"), upload("c.md")], async (operation) => { started.push(operation.key); if (operation.key === "b.md") await pending; return { status: "applied", key: operation.key }; }));
    env.scheduler.requestReconcile("startup"); env.timers.fire(); await flush(); env.hide(); release(); await flush();
    expect(started).toEqual(["a.md", "b.md"]); env.show(); expect(env.timers.delays()).toEqual([800]);
  });

  it("treats auth as cycle-global, retryable outcomes as exponential backoff, and stable failures as quiet", async () => {
    const authStarted: string[] = []; const auth = setup(() => base([upload("a.md"), upload("b.md")], async (operation) => { authStarted.push(operation.key); return { status: "failed", key: operation.key, error: "denied", httpStatus: 403 }; }));
    auth.scheduler.requestReconcile("startup"); auth.timers.fire(); await flush(); expect(authStarted).toEqual(["a.md"]); expect(auth.scheduler.diagnostics().currentState).toBe("blocked-by-auth"); expect(auth.timers.delays()).toEqual([]);
    const retry = setup(() => base([upload("a.md")], async (operation) => ({ status: "unresolved", key: operation.key, reason: "ambiguous-put" })));
    retry.scheduler.requestReconcile("startup"); retry.timers.fire(); await flush(); expect(retry.timers.delays()).toEqual([5000]); retry.timers.fire(5000); await flush(); expect(retry.timers.delays()).toEqual([0]); retry.timers.fire(0); await flush(); expect(retry.timers.delays()).toEqual([10000]);
    const stable = setup(() => base([upload("a.md")], async (operation) => ({ status: "failed", key: operation.key, error: "path", reason: "parent-path-is-file" })));
    stable.scheduler.requestReconcile("startup"); stable.timers.fire(); await flush(); expect(stable.timers.delays()).toEqual([]);
  });

  it("surfaces blocked deletes and conflicts without preventing unrelated operations", async () => {
    const executed: string[] = []; const { scheduler, timers } = setup(() => base([{ type: "conflict", key: "a", conflict: "both-modified", reason: "test" }, { type: "delete-remote", key: "b", reason: "test" }, upload("c")], async (operation) => { executed.push(operation.key); return operation.type === "delete-remote" ? { status: "blocked", key: operation.key, reason: "deletion-not-supported-in-phase-2a" } : { status: "applied", key: operation.key }; }));
    scheduler.requestReconcile("startup"); timers.fire(); await flush(); expect(executed).toEqual(["b", "c"]); expect(scheduler.diagnostics().lastResultCounts).toMatchObject({ conflict: 1, blocked: 1, applied: 1 }); expect(timers.delays()).toEqual([]);
  });

  it("unload prevents the next operation after the in-flight one completes", async () => {
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; }); const started: string[] = [];
    const { scheduler, timers } = setup(() => base([upload("a"), upload("b"), upload("c")], async (operation) => { started.push(operation.key); if (operation.key === "b") await pending; return { status: "applied", key: operation.key }; }));
    scheduler.requestReconcile("startup"); timers.fire(); await flush(); scheduler.stop(); release(); await flush(); expect(started).toEqual(["a", "b"]); expect(timers.delays()).toEqual([]);
  });
});
