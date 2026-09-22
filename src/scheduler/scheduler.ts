import { RemoteHttpError, RemoteTransportError } from "../remote/errors";
import { canonicalKey } from "../sync/path";
import type { OperationResult } from "../sync/executor";
import type { SyncOperation } from "../sync/types";
import type { ConfirmationOutcome, ConflictObservation, CycleRemoteMutation, FailureClass, ReconcileReason, ResultCounts, SchedulerDependencies, SchedulerDiagnostics, SchedulerState, SchedulerTimers, RemoteGenerationHandshake } from "./types";

const LOCAL_DEBOUNCE = 1200;
const FOCUS_DEBOUNCE = 800;
const CONFIG_DEBOUNCE = 400;
const RETRY_INITIAL = 5000;
const RETRY_MAX = 60000;

const emptyCounts = (): ResultCounts => ({ applied: 0, stale: 0, failed: 0, unresolved: 0, blocked: 0, partial: 0, conflict: 0, noop: 0 });
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
  private lastHandshakeStart?: string;
  private lastConfirmation?: ConfirmationOutcome["kind"];
  private lastCycleRemoteMutation = false;

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
    return { lastCycleStartedAt: this.lastCycleStartedAt, lastCycleFinishedAt: this.lastCycleFinishedAt, lastCycleReason: this.lastCycleReason, lastResultCounts: { ...this.lastResultCounts }, lastFailureClass: this.lastFailureClass, pendingDirtyCount: this.dirty.size, syncDirtyVersion: this.syncDirtyVersion, currentState: this.state, configGeneration: this.configGeneration, stopped: this.stopped, lastHandshakeStart: this.lastHandshakeStart, lastConfirmation: this.lastConfirmation, lastCycleRemoteMutation: this.lastCycleRemoteMutation };
  }

  private delayFor(reason: ReconcileReason): number {
    if (reason === "manual" || reason === "conflict-manual-resolution") return 0;
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
    let remoteMutation: CycleRemoteMutation | undefined;
    const resultDetails = new Map<string, number>();
    const conflicts: ConflictObservation[] = [];
    const handshake: RemoteGenerationHandshake = { startFailed: false, observationComplete: true };
    this.lastCycleStartedAt = Date.now(); this.lastCycleReason = reason; this.lastHandshakeStart = undefined; this.lastConfirmation = undefined; this.lastCycleRemoteMutation = false;
    this.dependencies.debug?.(`cycle start reason=${reason} generation=${generation}`);
    try {
      const cycle = this.dependencies.captureCycle();
      if (this.shouldStop(generation)) halted = true;
      if (!halted) {
        // The opening generation boundary is captured before any remote observation. It is only
        // attempted when a remote signal actually exists, so an ordinary local-only cycle pays no
        // extra round trip for a window it was never asked to prove.
        await this.captureHandshakeStart(handshake);
        const local = await cycle.scanLocal();
        this.dependencies.debug?.(`cycle local-scan entries=${local.size}`);
        const [remote, stored] = await Promise.all([cycle.scanRemote(), cycle.loadPrevious()]);
        this.dependencies.debug?.(`cycle remote-scan entries=${remote.size} previous-stored=${stored.size}`);
        if (this.shouldStop(generation)) halted = true;
        if (!halted) {
          const plan = cycle.buildPlan(local, remote, cycle.filterPrevious(stored));
          if (cycle.observeConflicts) conflicts.push(...cycle.observeConflicts(plan.operations.filter((entry): entry is Extract<SyncOperation, { type: "conflict" }> => entry.type === "conflict")));
          const planCounts = new Map<string, number>();
          for (const operation of plan.operations) planCounts.set(operation.type, (planCounts.get(operation.type) ?? 0) + 1);
          this.dependencies.debug?.(`cycle plan operations=${plan.operations.length} counts=${JSON.stringify(Object.fromEntries(planCounts))}`);
          for (const operation of plan.operations) {
            if (this.shouldStop(generation)) { halted = true; break; }
            // Each operation is executed exactly once and its result classified once: the loop and
            // the `finally` block must never disagree about what counts as a shortfall.
            const result = await this.apply(operation, cycle);
            counts[result.status]++;
            const detail = resultDetail(result);
            if (detail) resultDetails.set(detail, (resultDetails.get(detail) ?? 0) + 1);
            if (result.status === "stale") stale = true;
            const mutation = observeRemoteMutation(operation, result);
            if (mutation === "confirmed" || (mutation === "possible" && remoteMutation !== "confirmed")) remoteMutation = mutation;
            // A resolution that actually applied is retired here, once, outside the planner: the
            // conflict it described no longer exists, and keeping its intent would let a stale decision
            // be replayed later.
            if (result.status === "applied" && isResolution(operation) && this.dependencies.onResolutionApplied) {
              try { await this.dependencies.onResolutionApplied(operation.conflictId, operation.key); }
              catch { this.dependencies.debug?.("resolution cleanup failed"); }
            }
            // Only a shortfall discovered *before* the operation loop means the loop never reached
            // its deterministic end. A shortfall discovered by an operation itself is recorded in
            // `failures` (when it is a cycle failure) or is a normal shortfall that does not by
            // itself change cycle control flow.
            if (this.shouldStop(generation)) { halted = true; break; }
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
    }

    // The exit handshake runs before the dirty-version pruning in `finally`, because a mismatched
    // window must schedule a follow-up on its own terms rather than through the debounce path.
    let outcome: ConfirmationOutcome = { kind: "not-requested" };
    try {
      outcome = await this.finishGenerationHandshake(handshake, { halted, counts, stale, remoteMutation });
      failure = applyConfirmationFailure(outcome, failure);
    } catch {
      outcome = { kind: "notify-failed" };
      if (failure === undefined) failure = "retryable";
    }
    this.lastConfirmation = outcome.kind;

    this.lastCycleFinishedAt = Date.now(); this.lastResultCounts = counts; this.lastFailureClass = failure;
    this.lastCycleRemoteMutation = remoteMutation !== undefined;
    // Conflicts are handed to the coordinator after the cycle has fully executed. Nothing here
    // rewrites the plan that just ran; a resolution the coordinator records is applied by a later
    // cycle, which keeps `planner` the only decision maker and `event != operation` intact.
    if (conflicts.length && this.dependencies.onConflicts) {
      try { await this.dependencies.onConflicts(conflicts); }
      catch { this.dependencies.debug?.("conflict coordination failed"); }
    }
    // No await occurs between comparison and pruning, so a later event cannot be swallowed.
    for (const [key, version] of this.dirty) if (version <= startVersion) this.dirty.delete(key);
    const localDirty = this.syncDirtyVersion > startVersion || this.rerunRequested || outcome.kind === "mismatch";
    this.finishCycle(generation, failure, stale, localDirty, halted);
    this.dependencies.debug?.(`cycle end counts=${JSON.stringify(counts)} details=${JSON.stringify(Object.fromEntries(resultDetails))} confirmation=${outcome.kind} mutation=${remoteMutation ?? "none"} dirty=${this.dirty.size}`);
  }
  private async apply(operation: SyncOperation, cycle: ReturnType<SchedulerDependencies["captureCycle"]>): Promise<OperationResult | { status: "noop" | "conflict" }> {
    if (operation.type === "noop") return { status: "noop" };
    if (operation.type === "conflict") return { status: "conflict" };
    return cycle.execute(operation);
  }  private shouldStop(generation: number): boolean { return this.stopped || !this.dependencies.visible() || this.configGeneration !== generation; }

  /**
   * Opening boundary. A failure here is not a data-plane failure: the cycle still runs, R2 is still
   * reconciled, and the only consequence is that no generation may be confirmed.
   */
  private async captureHandshakeStart(handshake: RemoteGenerationHandshake): Promise<void> {
    const remote = this.dependencies.remoteChange;
    if (!remote) return;
    const requested = this.lastCycleReason === "remote-change" || remote.hasPending();
    if (!requested) return;
    const result = await this.readRemoteGenerationSafely(remote);
    if (result.ok) { handshake.start = result.generation; this.lastHandshakeStart = result.generation; return; }
    handshake.startFailed = true;
    this.dependencies.debug?.(`cycle handshake start unavailable kind=${result.kind}`);
  }

  /** A control-plane read can never throw into cycle control flow. */
  private async readRemoteGenerationSafely(remote: NonNullable<SchedulerDependencies["remoteChange"]>): Promise<{ ok: true; generation: string } | { ok: false; kind: string }> {
    try { return await remote.readGeneration(); } catch { return { ok: false, kind: "transport" }; }
  }

  /**
   * Closing boundary and cursor advance.
   *
   * `remoteObservationComplete` is the honest answer to "could this window have covered a
   * generation?" — not "did every operation succeed". A conflict or a blocked delete is a
   * deterministic conclusion about remote state that a full LIST already reached, so a new
   * generation is required before it is worth looking again; treating it as incomplete would mean
   * re-listing forever without any external change. `stale`, `unresolved`, `failed`, and a missing
   * boundary are the cases where the window genuinely may not have seen the truth.
   */
  private async finishGenerationHandshake(handshake: RemoteGenerationHandshake, state: { halted: boolean; counts: ResultCounts; stale: boolean; remoteMutation: CycleRemoteMutation | undefined }): Promise<ConfirmationOutcome> {
    const remote = this.dependencies.remoteChange;
    const outcome = await this.confirmGeneration(handshake, state);
    if (remote && state.remoteMutation !== undefined) {
      // Writer notification, coalesced to one call per cycle and issued once the boundary is final.
      // Notification can neither roll back a committed write nor reclassify any operation result.
      try {
        const notified = await remote.notifyRemoteDirty();
        if (!notified.ok) this.dependencies.debug?.(`gateway notify failed kind=${notified.kind}`);
      } catch { this.dependencies.debug?.("gateway notify failed kind=transport"); }
    }
    return outcome;
  }

  private async confirmGeneration(handshake: RemoteGenerationHandshake, state: { halted: boolean; counts: ResultCounts; stale: boolean }): Promise<ConfirmationOutcome> {
    const remote = this.dependencies.remoteChange;
    if (!remote) return { kind: "not-requested" };
    if (handshake.start === undefined) return handshake.startFailed ? { kind: "start-unavailable" } : { kind: "not-requested" };
    const observationComplete = isRemoteObservationComplete(state);
    handshake.observationComplete = observationComplete;
    if (!observationComplete) {
      this.dependencies.debug?.("cycle observation incomplete; cursor retained");
      return { kind: "observation-incomplete" };
    }
    let end: { ok: true; generation: string } | { ok: false; kind: string };
    end = await this.readRemoteGenerationSafely(remote);
    if (!end.ok) {
      this.dependencies.debug?.(`cycle handshake end unavailable kind=${end.kind}`);
      return { kind: "notify-failed" };
    }
    if (end.generation !== handshake.start) {
      // A writer advanced the remote during this window, so this cycle cannot prove it covered that
      // generation. The cursor stays put and a follow-up cycle is scheduled.
      this.dependencies.debug?.(`cycle handshake mismatch start=${handshake.start} end=${end.generation}`);
      return { kind: "mismatch", start: handshake.start, end: end.generation };
    }
    await remote.confirmReconciled(handshake.start);
    return { kind: "confirmed", generation: handshake.start };
  }
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
    // A stable failure (a blocked Vault path, a definitive 4xx) is deliberately quiet: it will not
    // resolve itself, so only a new local event or an explicit trigger is worth another cycle.
    if (stale) { this.pendingReason = "stale"; this.scheduleDebounce(0); return; }
    // A remote window this cycle could not prove stays pending, but it does not start another cycle
    // by itself: a new announcement or the retry timer above is what wakes it. An unconditional
    // immediate rerun here would be a busy loop against a Gateway that cannot answer.
    this.state = "idle"; this.publish();
  }
  private publish(): void { this.dependencies.onStatus?.(this.state, this.lastResultCounts); }
}

/**
 * Maps a cycle's aggregate result onto "could this window have covered a generation?".
 *
 * This is deliberately **not** `applied === total`, and not "everything succeeded". A conflict, a
 * blocked delete, and a definitive per-key failure are all deterministic conclusions that a full
 * remote LIST already reached; treating them as incomplete would re-list forever without any
 * external change, which is exactly the busy loop this contract exists to prevent.
 *
 * The cases where the window genuinely may not have seen the truth are:
 *
 * - `stale` — an observation was proven wrong during execution, so a write was not attempted.
 * - `unresolved` — a PUT's outcome is unknown, so remote state may differ from the LIST.
 * - `halted` — config/visibility/unload stopped the cycle before the loop reached its end, so the
 *   remote was never fully observed.
 */
export function isRemoteObservationComplete(counts: { counts: ResultCounts; stale: boolean; halted: boolean }): boolean {
  if (counts.halted) return false;
  if (counts.stale) return false;
  return counts.counts.unresolved === 0;
}

function applyConfirmationFailure(outcome: ConfirmationOutcome, failure: FailureClass | undefined): FailureClass | undefined {
  if (outcome.kind === "notify-failed" || outcome.kind === "start-unavailable") return failure === undefined ? "retryable" : failure;
  return failure;
}

/** Only a confirmed upload changed R2 for certain; an unknown PUT might have. */
export function observeRemoteMutation(operation: SyncOperation, result: OperationResult | { status: "noop" | "conflict" }): CycleRemoteMutation | undefined {
  if (operation.type !== "upload") return undefined;
  if (result.status === "applied") return "confirmed";
  // An ambiguous PUT may or may not have landed. The executor's verdict stays `unresolved` and no
  // baseline is committed; an extra best-effort wake-up is what keeps a landed write from being
  // invisible to other devices.
  if (result.status === "unresolved" && result.reason === "ambiguous-put") return "possible";
  // `stale` is decided before the conditional request, and a 4xx/blocked upload provably did not
  // change the remote, so none of them justifies waking other clients.
  return undefined;
}

/** Resolutions are the only operations carrying a conflict identity. */
function isResolution(operation: SyncOperation): operation is Extract<SyncOperation, { type: "resolve-keep-local" | "resolve-keep-remote" | "resolve-merged" }> {
  return operation.type === "resolve-keep-local" || operation.type === "resolve-keep-remote" || operation.type === "resolve-merged";
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
