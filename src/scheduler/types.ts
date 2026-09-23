import type { OperationResult } from "../sync/executor";
import type { RemoteChange } from "@mineral/sync-core/sync-change";
import type { LocalEntry, PreviousEntry, RemoteDeletionIdentity, RemoteEntry, SyncOperation, SyncPlan } from "../sync/types";

export type ReconcileReason = "startup" | "manual" | "local-event" | "editor-change" | "focus-resume" | "foreground-resume" | "integrity-check" | "config-change" | "stale" | "retry" | "remote-change" | "conflict-auto-merge" | "conflict-manual-resolution";
export type SchedulerState = "idle" | "debouncing" | "running" | "rerun-pending" | "blocked-by-auth";
export type FailureClass = "retryable" | "stable" | "auth";
/**
 * `partial` is a resolution-specific outcome: the remote half of a resolution landed but the local
 * half could not be completed. It is counted separately from `applied` because it deliberately leaves
 * the baseline uncommitted and needs one more reconciliation.
 */
export type ResultKind = OperationResult["status"] | "conflict" | "noop";
export type ResultCounts = Record<ResultKind, number>;

export interface SchedulerTimers {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

/**
 * What a cycle exposes to the scheduler. The scheduler observes remote mutations itself, from the
 * operation it just ran and the result it received, so the executor and the R2 layers gain no
 * knowledge of a control plane.
 */
export type CycleRemoteMutation = "confirmed" | "possible";

export interface CycleDependencies {
  scanLocal(): Map<string, LocalEntry> | Promise<Map<string, LocalEntry>>;
  scanRemote(): Promise<Map<string, RemoteEntry>>;
  /** Exact-path observations for a trusted gateway event; never lists R2 or tombstones. */
  incrementalObservations?(changes: RemoteChange[]): Promise<{ local: Map<string, LocalEntry>; remote: Map<string, RemoteEntry>; previous: Map<string, PreviousEntry> }>;
  /** Exact-path observations for coalesced local Vault events; never lists R2 or tombstones. */
  localIncrementalObservations?(keys: string[]): Promise<{ local: Map<string, LocalEntry>; remote: Map<string, RemoteEntry>; previous: Map<string, PreviousEntry> }>;
  loadPrevious(): Promise<Map<string, PreviousEntry>>;
  filterPrevious(entries: Map<string, PreviousEntry>): Map<string, PreviousEntry>;
  buildPlan(local: Map<string, LocalEntry>, remote: Map<string, RemoteEntry>, previous: Map<string, PreviousEntry>): SyncPlan;
  execute(operation: SyncOperation): Promise<OperationResult>;
  /** Confirms an executor-originated Vault write has not been changed again before its event is ignored. */
  localWriteStillMatches?(entry: LocalEntry): Promise<boolean>;
  /**
   * The identity inputs behind a conflicted key, gathered from the maps the planner already received.
   * This carries no content and performs no I/O: the coordinator reads content itself, after the
   * cycle, so a running plan is never mutated by conflict handling.
   */
  observeConflicts?(conflicts: Array<Extract<SyncOperation, { type: "conflict" }>>, observations: {
    local: Map<string, LocalEntry>;
    remote: Map<string, RemoteEntry>;
    previous: Map<string, PreviousEntry>;
  }): ConflictObservation[];
  /**
   * Lets the application seed merge bases from files that this plan proved were already converged.
   * This is observation-only bookkeeping; a conflict is never eligible for a backfilled base.
   */
  observeConverged?(operations: Array<Extract<SyncOperation, { type: "noop" }>>, observations: {
    local: Map<string, LocalEntry>;
    remote: Map<string, RemoteEntry>;
    previous: Map<string, PreviousEntry>;
  }): Promise<void>;
}

/**
 * The Gateway control plane, as the scheduler sees it: three questions and one best-effort side
 * effect. Deliberately this narrow — the scheduler must not know about sockets, tickets, channels,
 * or HTTP, and the Gateway client must not know about cycles.
 */
export interface SchedulerRemoteChange {
  /** Is there an announced remote generation a completed cycle has not yet covered? */
  hasPending(): boolean;
  readGeneration(): Promise<{ ok: true; generation: string } | { ok: false; kind: string }>;
  /** Records the generation a completed window proved. Never called on an incomplete window. */
  confirmReconciled(generation: string): Promise<void>;
  /** Best-effort wake-up for other clients. Its result never changes a cycle's outcome. */
  notifyRemoteDirty(changes?: RemoteChange[]): Promise<{ ok: true; generation: string } | { ok: false; kind: string }>;
  /** The persisted cursor makes this generation the exact next remote event. */
  canApplyIncrementally(generation: string): boolean;
}

/**
 * The remote-mutation journal, as the scheduler sees it.
 *
 * A second control-plane port rather than a method on the Gateway one, because it is a different
 * service with a different contract: the Gateway is told "the remote may have changed", while a
 * mutation is *the fact itself*, verified against R2 by the receiver. The scheduler only has to hand
 * over what it observed — which writes landed, and with which revision — and is told nothing back.
 */
export interface SchedulerMutationIngress {
  /** Records writes that landed, with the revision each left in R2. Never changes a cycle's outcome. */
  report(changes: readonly RemoteChange[]): Promise<void>;
}

export interface SchedulerDependencies {
  captureCycle(): CycleDependencies;
  visible(): boolean;
  remoteChange?: SchedulerRemoteChange;
  /** The journal that owns the truth about writes this device performed. */
  mutationIngress?: SchedulerMutationIngress;
  /**
   * Observes the conflicts a plan produced, after the cycle has executed. It is deliberately a
   * post-cycle hook rather than something the planner calls: a cycle's plan is never rewritten while
   * it is running, so any resolution this produces is applied by a *later* cycle.
   */
  onConflicts?(conflicts: ConflictObservation[]): Promise<void>;
  /**
   * Reports that a resolution actually applied, so its conflict record and intent can be retired.
   * Only `applied` is reported: a `stale` or `partial` resolution must keep its conflict visible,
   * because the disagreement still exists in a form the user has to see.
   */
  onResolutionApplied?(conflictId: string, path: string): Promise<void>;
  timers?: SchedulerTimers;
  onStatus?(state: SchedulerState, counts: ResultCounts): void;
  debug?(message: string): void;
}

/** The minimum a conflict observation needs to carry: identity inputs, never content. */
export interface ConflictObservation {
  key: string;
  previous?: PreviousEntry;
  observedLocal?: LocalEntry;
  observedRemote?: RemoteEntry;
  observedRemoteDeletion?: RemoteDeletionIdentity;
}

export type RemoteGenerationHandshake = {
  /** A handshake was requested and its opening boundary was read successfully. */
  start?: string;
  /** The opening read failed, so no boundary exists and the cursor must not move. */
  startFailed: boolean;
  /** The cycle's remote observation was complete enough to be able to cover a generation. */
  observationComplete: boolean;
};

export type ConfirmationOutcome =
  | { kind: "not-requested" }
  | { kind: "start-unavailable" }
  | { kind: "observation-incomplete" }
  | { kind: "notify-failed" }
  | { kind: "superseded" }
  | { kind: "mismatch"; start: string; end: string }
  | { kind: "confirmed"; generation: string };

export interface SchedulerDiagnostics {
  lastCycleStartedAt?: number;
  lastCycleFinishedAt?: number;
  lastCycleReason?: ReconcileReason;
  lastResultCounts: ResultCounts;
  lastFailureClass?: FailureClass;
  pendingDirtyCount: number;
  /** Remote deltas that have been announced but not yet covered by a completed observation window. */
  pendingRemoteDeltaCount: number;
  syncDirtyVersion: number;
  currentState: SchedulerState;
  configGeneration: number;
  stopped: boolean;
  /** Generation boundary captured at the start of the last cycle, when a handshake was attempted. */
  lastHandshakeStart?: string;
  /** Outcome of the last cycle's generation handshake. */
  lastConfirmation?: ConfirmationOutcome["kind"];
  /** A completed cycle changed R2 during this session (confirmed or possibly). */
  lastCycleRemoteMutation: boolean;
}
