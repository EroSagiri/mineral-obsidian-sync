import { RemoteHttpError, RemoteTransportError } from "../remote/errors";
import { canonicalKey } from "../sync/path";
import type { OperationResult } from "../sync/executor";
import type { SyncOperation } from "../sync/types";
import type { CycleDependencies, FailureClass, ReconcileReason, ResultCounts, SchedulerDependencies, SchedulerDiagnostics, SchedulerState, SchedulerTimers } from "./types";

const LOCAL_DEBOUNCE = 1200;
const FOCUS_DEBOUNCE = 800;
const CONFIG_DEBOUNCE = 400;
const RETRY_INITIAL = 5000;
const RETRY_MAX = 60000;

const emptyCounts = (): ResultCounts => ({ applied: 0, stale: 0, failed: 0, unresolved: 0, blocked: 0, conflict: 0, noop: 0 });
const defaultTimers: SchedulerTimers = { set: (delay, callback) => window.setTimeout(callback, delay), clear: (handle) => window.clearTimeout(handle as number) };

/** Event-driven, full-reconciliation scheduler. Dirty keys are only coalescing hints. */
export class SyncScheduler {
  private readonly timers: SchedulerTimers;
  private state: SchedulerState = "idle";
  private stopped = false;
  private configGeneration = 0;
  private syncDirtyVersion = 0;
  private readonly dirty = new Map<string, number>();
  private debounceTimer?: unknown;
  private retryTimer?: unknown;
  private retryDelay = RETRY_INITIAL;
  private pendingReason?: ReconcileReason;
  private rerunRequested = false;
  private lastCycleStartedAt?: number;
  private lastCycleFinishedAt?: number;
  private lastCycleReason?: ReconcileReason;
  private lastResultCounts = emptyCounts();
  private lastFailureClass?: FailureClass;

  constructor(private readonly dependencies: SchedulerDependencies) { this.timers = dependencies.timers ?? defaultTimers; }

  requestReconcile(reason: ReconcileReason): void {
    if (this.stopped || !this.dependencies.visible() || this.state === "blocked-by-auth") return;
    this.pendingReason = reason;
    if (this.state === "running") { this.rerunRequested = true; return; }
    this.scheduleDebounce(this.delayFor(reason));
  }

  /** Accepts only relevant file paths; callers deliberately do not pass event kind into planning. */
  markLocalPaths(paths: string[], ignores: (key: string) => boolean): boolean {
    const keys = new Set<string>();
    for (const path of paths) {
      try { const key = canonicalKey(path); if (!ignores(key)) keys.add(key); } catch { /* malformed event paths carry no sync fact */ }
    }
    if (!keys.size) return false;
    const version = ++this.syncDirtyVersion;
    for (const key of keys) this.dirty.set(key, version);
    this.requestReconcile("local-event");
    return true;
  }

  configChanged(): void {
    this.configGeneration++;
    if (this.state === "blocked-by-auth") this.state = "idle";
    this.clearTimer("debounce"); this.clearTimer("retry");
    this.retryDelay = RETRY_INITIAL;
    if (!this.stopped && this.dependencies.visible()) this.requestReconcile("config-change");
    this.publish();
  }

  visibilityChanged(visible: boolean): void {
    if (!visible) { this.clearTimer("debounce"); this.clearTimer("retry"); if (this.state === "debouncing") this.state = "idle"; this.publish(); return; }
    if (this.state !== "blocked-by-auth") this.requestReconcile("focus-resume");
  }

  stop(): void {
    this.stopped = true; this.clearTimer("debounce"); this.clearTimer("retry");
    if (this.state !== "running") this.state = "idle";
    this.publish();
  }

  refreshStatus(): void { this.publish(); }
  diagnostics(): SchedulerDiagnostics {
    return { lastCycleStartedAt: this.lastCycleStartedAt, lastCycleFinishedAt: this.lastCycleFinishedAt, lastCycleReason: this.lastCycleReason, lastResultCounts: { ...this.lastResultCounts }, lastFailureClass: this.lastFailureClass, pendingDirtyCount: this.dirty.size, syncDirtyVersion: this.syncDirtyVersion, currentState: this.state, configGeneration: this.configGeneration, stopped: this.stopped };
  }

  private delayFor(reason: ReconcileReason): number {
    if (reason === "config-change") return CONFIG_DEBOUNCE;
    if (reason === "focus-resume") return FOCUS_DEBOUNCE;
    if (reason === "stale" || reason === "retry") return 0;
    return LOCAL_DEBOUNCE;
  }
  private scheduleDebounce(delay: number): void {
    this.clearTimer("debounce");
    this.state = "debouncing"; this.publish();
    this.debounceTimer = this.timers.set(delay, () => { this.debounceTimer = undefined; void this.runCycle(); });
  }
  private scheduleRerun(): void {
    this.clearTimer("debounce");
    this.state = "rerun-pending"; this.publish();
    this.debounceTimer = this.timers.set(LOCAL_DEBOUNCE, () => { this.debounceTimer = undefined; void this.runCycle(); });
  }
  private clearTimer(kind: "debounce" | "retry"): void {
    const handle = kind === "debounce" ? this.debounceTimer : this.retryTimer;
    if (handle !== undefined) this.timers.clear(handle);
    if (kind === "debounce") this.debounceTimer = undefined; else this.retryTimer = undefined;
  }
  private async runCycle(): Promise<void> {
    if (this.stopped || !this.dependencies.visible() || this.state === "blocked-by-auth") return;
    const reason = this.pendingReason ?? "local-event";
    this.pendingReason = undefined; this.rerunRequested = false; this.state = "running"; this.publish();
    const startVersion = this.syncDirtyVersion;
    const generation = this.configGeneration;
    const counts = emptyCounts(); let failure: FailureClass | undefined; let stale = false; let halted = false;
    const resultDetails = new Map<string, number>();
    this.lastCycleStartedAt = Date.now(); this.lastCycleReason = reason;
    this.dependencies.debug?.(`cycle start reason=${reason} generation=${generation}`);
    try {
      const cycle = this.dependencies.captureCycle();
      if (this.shouldStop(generation)) halted = true;
      if (!halted) {
        const local = cycle.scanLocal();
        this.dependencies.debug?.(`cycle local-scan entries=${local.size}`);
        const [remote, stored] = await Promise.all([cycle.scanRemote(), cycle.loadPrevious()]);
        this.dependencies.debug?.(`cycle remote-scan entries=${remote.size} previous-stored=${stored.size}`);
        if (this.shouldStop(generation)) halted = true;
        if (!halted) {
          const plan = cycle.buildPlan(local, remote, cycle.filterPrevious(stored));
          const planCounts = new Map<string, number>();
          for (const operation of plan.operations) planCounts.set(operation.type, (planCounts.get(operation.type) ?? 0) + 1);
          this.dependencies.debug?.(`cycle plan operations=${plan.operations.length} counts=${JSON.stringify(Object.fromEntries(planCounts))}`);
          for (const operation of plan.operations) {
            if (this.shouldStop(generation)) { halted = true; break; }
            const result = await this.apply(operation, cycle);
            counts[result.status]++;
            const detail = resultDetail(result);
            if (detail) resultDetails.set(detail, (resultDetails.get(detail) ?? 0) + 1);
            if (result.status === "stale") stale = true;
            const classified = classify(result);
            if (classified === "auth") { failure = "auth"; halted = true; break; }
            if (classified === "retryable") failure = "retryable";
            else if (classified === "stable" && failure === undefined) failure = "stable";
            if (this.shouldStop(generation)) { halted = true; break; }
          }
        }
      }
    } catch (error) {
      failure = classifyError(error);
      this.dependencies.debug?.(`cycle error class=${failure}`);
    } finally {
      this.lastCycleFinishedAt = Date.now(); this.lastResultCounts = counts; this.lastFailureClass = failure;
      // No await occurs between comparison and pruning, so a later event cannot be swallowed.
      for (const [key, version] of this.dirty) if (version <= startVersion) this.dirty.delete(key);
      const localDirty = this.syncDirtyVersion > startVersion || this.rerunRequested;
      this.finishCycle(generation, failure, stale, localDirty, halted);
      this.dependencies.debug?.(`cycle end counts=${JSON.stringify(counts)} details=${JSON.stringify(Object.fromEntries(resultDetails))} dirty=${this.dirty.size}`);
    }
  }
  private async apply(operation: SyncOperation, cycle: CycleDependencies): Promise<OperationResult | { status: "noop" | "conflict" }> {
    if (operation.type === "noop") return { status: "noop" };
    if (operation.type === "conflict") return { status: "conflict" };
    return cycle.execute(operation);
  }
  private shouldStop(generation: number): boolean { return this.stopped || !this.dependencies.visible() || this.configGeneration !== generation; }
  private finishCycle(generation: number, failure: FailureClass | undefined, stale: boolean, localDirty: boolean, _halted: boolean): void {
    if (this.stopped) { this.state = "idle"; this.publish(); return; }
    if (this.configGeneration !== generation) { this.state = "idle"; this.requestReconcile("config-change"); return; }
    if (failure === "auth") { this.clearTimer("debounce"); this.clearTimer("retry"); this.state = "blocked-by-auth"; this.publish(); return; }
    if (!this.dependencies.visible()) { this.state = "idle"; this.publish(); return; }
    if (localDirty) { this.retryDelay = RETRY_INITIAL; this.pendingReason = "local-event"; this.scheduleRerun(); return; }
    if (failure === "retryable") {
      this.state = "idle"; const delay = this.retryDelay; this.retryDelay = Math.min(RETRY_MAX, this.retryDelay * 2);
      this.retryTimer = this.timers.set(delay, () => { this.retryTimer = undefined; this.requestReconcile("retry"); }); this.publish(); return;
    }
    this.retryDelay = RETRY_INITIAL;
    if (stale) { this.pendingReason = "stale"; this.scheduleDebounce(0); return; }
    this.state = "idle"; this.publish();
  }
  private publish(): void { this.dependencies.onStatus?.(this.state, this.lastResultCounts); }
}

function classify(result: OperationResult | { status: "noop" | "conflict" }): FailureClass | undefined {
  if (result.status === "unresolved") return "retryable";
  if (result.status !== "failed") return undefined;
  if (result.httpStatus === 401 || result.httpStatus === 403) return "auth";
  if (result.httpStatus === 429 || (result.httpStatus !== undefined && result.httpStatus >= 500)) return "retryable";
  return "stable";
}
function classifyError(error: unknown): FailureClass {
  if (error instanceof RemoteHttpError) {
    if (error.status === 401 || error.status === 403) return "auth";
    if (error.status === 429 || error.status >= 500) return "retryable";
    return "stable";
  }
  return error instanceof RemoteTransportError ? "retryable" : "stable";
}

/** Diagnostic categories only: never log a key, an exception message, or remote request metadata. */
function resultDetail(result: OperationResult | { status: "noop" | "conflict" }): string | undefined {
  if (result.status === "failed") return result.reason ?? (result.httpStatus ? `http-${result.httpStatus}` : "failed-unclassified");
  if (result.status === "unresolved" || result.status === "blocked" || result.status === "stale") return result.reason;
  return undefined;
}
