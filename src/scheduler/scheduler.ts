import { RemoteHttpError, RemoteTransportError } from "../remote/errors";
import { canonicalKey } from "../sync/path";
import type { OperationResult } from "../sync/executor";
import type { LocalEntry, SyncOperation } from "../sync/types";
import type { RemoteChange } from "@mineral/sync-core/sync-change";
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
  /** A remote announcement during a cycle needs another observation, but is not local typing. */
  private rerunReason?: ReconcileReason;
  private lastCycleStartedAt?: number;
  private lastCycleFinishedAt?: number;
  private lastCycleReason?: ReconcileReason;
  private lastResultCounts = emptyCounts();
  private lastFailureClass?: FailureClass;
  private lastHandshakeStart?: string;
  private lastConfirmation?: ConfirmationOutcome["kind"];
  private lastCycleRemoteMutation = false;
  private incrementalStateTrusted = false;
  private readonly pendingRemoteChanges: Array<{ generation: string; changes: RemoteChange[] }> = [];

  constructor(private readonly dependencies: SchedulerDependencies) { this.timers = dependencies.timers ?? defaultTimers; }

  requestReconcile(reason: ReconcileReason): void {
    if (this.stopped || !this.dependencies.visible() || this.state === "blocked-by-auth") return;
    if (this.state === "running") { this.rerunRequested = true; this.rerunReason = reason; return; }
    this.pendingReason = reason;
    this.scheduleDebounce(this.delayFor(reason));
  }

  /** Queues a concrete remote delta. Unknown or non-contiguous events deliberately use full mode. */
  requestRemoteChange(generation: string, changes?: RemoteChange[]): void {
    if (!changes?.length) { this.requestReconcile("remote-change"); return; }
    const existing = this.pendingRemoteChanges.find((entry) => entry.generation === generation);
    if (existing) existing.changes = changes;
    else this.pendingRemoteChanges.push({ generation, changes });
    this.requestReconcile("remote-change");
  }

  /** Accepts only relevant file paths; callers deliberately do not pass event kind into planning. */
  markLocalPaths(paths: string[], ignores: (key: string) => boolean, reason: "local-event" | "editor-change" = "local-event"): boolean {
    const keys = new Set<string>();
    for (const path of paths) {
      try { const key = canonicalKey(path); if (!ignores(key)) keys.add(key); } catch { /* malformed event paths carry no sync fact */ }
    }
    if (!keys.size) return false;
    const version = ++this.syncDirtyVersion;
    for (const key of keys) this.dirty.set(key, version);
    this.requestReconcile(reason);
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
    if (!visible) { this.incrementalStateTrusted = false; this.clearTimer("debounce"); this.clearTimer("retry"); if (this.state === "debouncing") this.state = "idle"; this.publish(); return; }
    if (this.state !== "blocked-by-auth") this.requestReconcile("foreground-resume");
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
    if (reason === "manual" || reason === "conflict-manual-resolution" || reason === "remote-change" || reason === "foreground-resume" || reason === "integrity-check") return 0;
    if (reason === "editor-change") return 300;
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
    this.pendingReason = undefined; this.rerunRequested = false; this.rerunReason = undefined; this.state = "running"; this.publish();
    const startVersion = this.syncDirtyVersion;
    const generation = this.configGeneration;
    const counts = emptyCounts(); let failure: FailureClass | undefined; let stale = false; let halted = false;
    let remoteMutation: CycleRemoteMutation | undefined;
    const remoteChanges: RemoteChange[] = [];
    const localWrites = new Map<string, LocalEntry>();
    const resultDetails = new Map<string, number>();
    const conflicts: ConflictObservation[] = [];
    const handshake: RemoteGenerationHandshake = { startFailed: false, observationComplete: true };
    const incremental = reason === "remote-change" && this.incrementalStateTrusted ? this.pendingRemoteChanges.shift() : undefined;
    const useRemoteIncremental = Boolean(incremental && this.dependencies.remoteChange?.canApplyIncrementally(incremental.generation));
    // The dirty map is already path-coalesced. Snapshot the keys before any I/O so events received
    // while this cycle is running remain dirty for a follow-up instead of being accidentally folded in.
    const localIncrementalKeys = (reason === "local-event" || reason === "editor-change")
      ? [...this.dirty.entries()].filter(([, version]) => version <= startVersion).map(([key]) => key)
      : [];
    const useLocalIncremental = !useRemoteIncremental && localIncrementalKeys.length > 0;
    let cycle: ReturnType<SchedulerDependencies["captureCycle"]> | undefined;
    const cycleStartedAt = Date.now();
    this.lastCycleStartedAt = cycleStartedAt; this.lastCycleReason = reason; this.lastHandshakeStart = undefined; this.lastConfirmation = undefined; this.lastCycleRemoteMutation = false;
    const cycleMode = useRemoteIncremental ? "incremental" : useLocalIncremental ? "local-incremental" : "full-reconcile";
    this.dependencies.debug?.(`cycle start reason=${reason} mode=${cycleMode} remoteGeneration=${incremental?.generation ?? "n/a"} localPaths=${localIncrementalKeys.length} incrementalStateTrusted=${this.incrementalStateTrusted}`);
    try {
      cycle = this.dependencies.captureCycle();
      if (this.shouldStop(generation)) halted = true;
      if (!halted) {
        // The opening generation boundary is captured before any complete remote observation. It is only
        // attempted when a remote signal actually exists, so an ordinary local-only cycle pays no
        // extra round trip for a window it was never asked to prove.
        let local: Map<string, LocalEntry>; let remote: Map<string, import("../sync/types").RemoteEntry>; let stored: Map<string, import("../sync/types").PreviousEntry>;
        if (useRemoteIncremental && incremental && cycle.incrementalObservations) {
          const startedAt = Date.now();
          ({ local, remote, previous: stored } = await cycle.incrementalObservations(incremental.changes));
          this.dependencies.debug?.(`incremental observations changes=${incremental.changes.length} entries=${remote.size} durationMs=${Date.now() - startedAt}`);
        } else if (useLocalIncremental && cycle.localIncrementalObservations) {
          const startedAt = Date.now();
          ({ local, remote, previous: stored } = await cycle.localIncrementalObservations(localIncrementalKeys));
          this.dependencies.debug?.(`local incremental observations paths=${localIncrementalKeys.length} entries=${remote.size} durationMs=${Date.now() - startedAt}`);
        } else {
          const openingHandshakeStartedAt = Date.now();
          await this.captureHandshakeStart(handshake);
          if (handshake.start !== undefined || handshake.startFailed) this.dependencies.debug?.(`cycle gateway-start durationMs=${Date.now() - openingHandshakeStartedAt}`);
          const localScanStartedAt = Date.now();
          local = await cycle.scanLocal();
          this.dependencies.debug?.(`cycle local-scan entries=${local.size} durationMs=${Date.now() - localScanStartedAt}`);
          const remoteScanStartedAt = Date.now();
          [remote, stored] = await Promise.all([cycle.scanRemote(), cycle.loadPrevious()]);
          this.dependencies.debug?.(`cycle remote-scan entries=${remote.size} previous-stored=${stored.size} durationMs=${Date.now() - remoteScanStartedAt}`);
        }
        if (this.shouldStop(generation)) halted = true;
        if (!halted) {
          const observations = { local, remote, previous: useRemoteIncremental || useLocalIncremental ? stored : cycle.filterPrevious(stored) };
          const plan = cycle.buildPlan(local, remote, observations.previous);
          if (cycle.observeConflicts) conflicts.push(...cycle.observeConflicts(plan.operations.filter((entry): entry is Extract<SyncOperation, { type: "conflict" }> => entry.type === "conflict"), observations));
          const planCounts = new Map<string, number>();
          for (const operation of plan.operations) planCounts.set(operation.type, (planCounts.get(operation.type) ?? 0) + 1);
          this.dependencies.debug?.(`cycle plan operations=${plan.operations.length} counts=${JSON.stringify(Object.fromEntries(planCounts))}`);
          const operationsStartedAt = Date.now();
          for (const operation of plan.operations) {
            if (this.shouldStop(generation)) { halted = true; break; }
            // Each operation is executed exactly once and its result classified once: the loop and
            // the `finally` block must never disagree about what counts as a shortfall.
            const result = await this.apply(operation, cycle);
            counts[result.status]++;
            if (result.status === "applied" && result.localWrite) localWrites.set(result.localWrite.key, result.localWrite);
            const detail = resultDetail(result);
            if (detail) resultDetails.set(detail, (resultDetails.get(detail) ?? 0) + 1);
            if (result.status === "stale" || result.status === "partial") stale = true;
            const mutation = observeRemoteMutation(operation, result);
            if (mutation === "confirmed" || (mutation === "possible" && remoteMutation !== "confirmed")) remoteMutation = mutation;
            if (mutation) {
              const change = remoteChangeForOperation(operation);
              if (change) remoteChanges.push(change);
            }
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
          this.dependencies.debug?.(`cycle operations durationMs=${Date.now() - operationsStartedAt}`);
          if (!halted && cycle.observeConverged) {
            const mergeBaseStartedAt = Date.now();
            const noops = plan.operations.filter((entry): entry is Extract<SyncOperation, { type: "noop" }> => entry.type === "noop");
            try {
              await cycle.observeConverged(noops, observations);
              this.dependencies.debug?.(`cycle merge-base-backfill noops=${noops.length} durationMs=${Date.now() - mergeBaseStartedAt}`);
            } catch { this.dependencies.debug?.("merge-base backfill failed"); }
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
    const confirmationStartedAt = Date.now();
    try {
      if (useRemoteIncremental && incremental) {
        const complete = isRemoteObservationComplete({ counts, stale, halted });
        if (complete) {
          await this.dependencies.remoteChange?.confirmReconciled(incremental.generation);
          outcome = { kind: "confirmed", generation: incremental.generation };
        } else outcome = { kind: "observation-incomplete" };
      } else outcome = await this.finishGenerationHandshake(handshake, { halted, counts, stale, remoteMutation, remoteChanges });
      failure = applyConfirmationFailure(outcome, failure);
    } catch {
      outcome = { kind: "notify-failed" };
      if (failure === undefined) failure = "retryable";
    }
    this.lastConfirmation = outcome.kind;
    if (!useRemoteIncremental && outcome.kind === "confirmed") { this.incrementalStateTrusted = true; this.pendingRemoteChanges.length = 0; }
    if (useRemoteIncremental && outcome.kind !== "confirmed" && incremental) this.pendingRemoteChanges.unshift(incremental);
    if (outcome.kind !== "not-requested") this.dependencies.debug?.(`cycle gateway-end outcome=${outcome.kind} durationMs=${Date.now() - confirmationStartedAt}`);

    this.lastCycleFinishedAt = Date.now(); this.lastResultCounts = counts; this.lastFailureClass = failure;
    this.lastCycleRemoteMutation = remoteMutation !== undefined;
    // Conflicts are handed to the coordinator after the cycle has fully executed. Nothing here
    // rewrites the plan that just ran; a resolution the coordinator records is applied by a later
    // cycle, which keeps `planner` the only decision maker and `event != operation` intact.
    //
    // The hook runs on *every* cycle, including one with no conflicts at all. An empty list is
    // meaningful: it is how the coordinator learns that records it still holds are no longer active
    // and must be dropped. Skipping the call would leave a resolved conflict visible in the UI forever.
    if (this.dependencies.onConflicts) {
      try { await this.dependencies.onConflicts(conflicts); }
      catch { this.dependencies.debug?.("conflict coordination failed"); }
    }
    // An executor-originated Vault write emits the same event as a user edit. Consume it only after
    // rechecking its exact size/mtime; a later user/plugin write therefore remains dirty and reruns.
    if (cycle?.localWriteStillMatches) {
      for (const [key, written] of localWrites) {
        const dirtyVersion = this.dirty.get(key);
        if (dirtyVersion !== undefined && dirtyVersion > startVersion && await cycle.localWriteStillMatches(written)) this.dirty.delete(key);
      }
    }
    // No await occurs between the version comparison and pruning, so a later event cannot be swallowed.
    for (const [key, version] of this.dirty) if (version <= startVersion) this.dirty.delete(key);
    const localDirty = [...this.dirty.values()].some((version) => version > startVersion);
    const queuedRemoteReason = this.rerunRequested && this.rerunReason !== "local-event" && this.rerunReason !== "editor-change" ? this.rerunReason : undefined;
    const remoteRerun = queuedRemoteReason ?? (outcome.kind === "mismatch" ? "remote-change" : undefined);
    this.finishCycle(generation, failure, stale, localDirty, remoteRerun, halted);
    this.dependencies.debug?.(`cycle end durationMs=${Date.now() - cycleStartedAt} counts=${JSON.stringify(counts)} details=${JSON.stringify(Object.fromEntries(resultDetails))} confirmation=${outcome.kind} mutation=${remoteMutation ?? "none"} dirty=${this.dirty.size}`);
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
  private async finishGenerationHandshake(handshake: RemoteGenerationHandshake, state: { halted: boolean; counts: ResultCounts; stale: boolean; remoteMutation: CycleRemoteMutation | undefined; remoteChanges: RemoteChange[] }): Promise<ConfirmationOutcome> {
    const remote = this.dependencies.remoteChange;
    const outcome = await this.confirmGeneration(handshake, state);
    if (remote && state.remoteMutation !== undefined) {
      // Writer notification, coalesced to one call per cycle and issued once the boundary is final.
      // Notification can neither roll back a committed write nor reclassify any operation result.
      try {
        const notified = await remote.notifyRemoteDirty(state.remoteChanges);
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
  private finishCycle(generation: number, failure: FailureClass | undefined, stale: boolean, localDirty: boolean, rerunReason: ReconcileReason | undefined, _halted: boolean): void {
    if (this.stopped) { this.state = "idle"; this.publish(); return; }
    if (this.configGeneration !== generation) { this.state = "idle"; this.requestReconcile("config-change"); return; }
    if (failure === "auth") { this.clearTimer("debounce"); this.clearTimer("retry"); this.state = "blocked-by-auth"; this.publish(); return; }
    if (!this.dependencies.visible()) { this.state = "idle"; this.publish(); return; }
    // A foreground recovery is a correctness boundary after a background suspension. It must not
    // wait behind editor debounce, even when an executor-owned or user edit event also arrived.
    if (rerunReason === "foreground-resume") { this.pendingReason = rerunReason; this.scheduleDebounce(0); return; }
    if (localDirty) { this.retryDelay = RETRY_INITIAL; this.pendingReason = "local-event"; this.scheduleRerun(); return; }
    // A Gateway announcement (including our own just-confirmed R2 write) must be observed again,
    // but it has no unstable editor buffer to protect. Run its confirmation window immediately.
    if (rerunReason) { this.pendingReason = rerunReason; this.scheduleDebounce(this.delayFor(rerunReason)); return; }
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

function remoteChangeForOperation(operation: SyncOperation): RemoteChange | undefined {
  if (operation.type === "delete-remote" || operation.type === "resolve-accept-local-delete") return { op: "delete", path: operation.key };
  if (operation.type === "upload" || operation.type === "resolve-keep-local" || operation.type === "resolve-merged") return { op: "put", path: operation.key };
  return undefined;
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
 * - `partial` — a confirmed R2 write exists, but its local counterpart changed before commit.
 * - `halted` — config/visibility/unload stopped the cycle before the loop reached its end, so the
 *   remote was never fully observed.
 */
export function isRemoteObservationComplete(counts: { counts: ResultCounts; stale: boolean; halted: boolean }): boolean {
  if (counts.halted) return false;
  if (counts.stale) return false;
  return counts.counts.unresolved === 0 && (counts.counts.partial ?? 0) === 0;
}

function applyConfirmationFailure(outcome: ConfirmationOutcome, failure: FailureClass | undefined): FailureClass | undefined {
  if (outcome.kind === "notify-failed" || outcome.kind === "start-unavailable") return failure === undefined ? "retryable" : failure;
  return failure;
}

/**
 * Which operations can have changed R2, and how certain that is.
 *
 * `resolve-keep-local` and `resolve-merged` write to R2 exactly like an upload, so another device
 * needs the same wake-up. `resolve-keep-remote` writes only locally and must not notify.
 */
export function observeRemoteMutation(operation: SyncOperation, result: OperationResult | { status: "noop" | "conflict" }): CycleRemoteMutation | undefined {
  const writesRemote = operation.type === "upload" || operation.type === "delete-remote" || operation.type === "resolve-keep-local" || operation.type === "resolve-merged" || operation.type === "resolve-accept-local-delete";
  if (!writesRemote) return undefined;
  if (result.status === "applied") return "confirmed";
  // An ambiguous PUT may or may not have landed. The executor's verdict stays `unresolved` and no
  // baseline is committed; an extra best-effort wake-up is what keeps a landed write from being
  // invisible to other devices.
  if (result.status === "unresolved" && result.reason === "ambiguous-put") return "possible";
  // A partial transfer DID reach R2, so other devices must still be woken even though this device
  // could not finish its own local-baseline half.
  if (result.status === "partial" && result.reason === "remote-applied-local-changed") return "confirmed";
  // `stale` is decided before the conditional request, and a 4xx/blocked upload provably did not
  // change the remote, so none of them justifies waking other clients.
  return undefined;
}

/** Resolutions are the only operations carrying a conflict identity. */
function isResolution(operation: SyncOperation): operation is Extract<SyncOperation, { type: "resolve-keep-local" | "resolve-keep-remote" | "resolve-merged" | "resolve-accept-remote-delete" | "resolve-accept-local-delete" }> {
  return operation.type === "resolve-keep-local" || operation.type === "resolve-keep-remote" || operation.type === "resolve-merged" || operation.type === "resolve-accept-remote-delete" || operation.type === "resolve-accept-local-delete";
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
