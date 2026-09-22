import type { OperationResult } from "../sync/executor";
import type { LocalEntry, PreviousEntry, RemoteEntry, SyncOperation, SyncPlan } from "../sync/types";

export type ReconcileReason = "startup" | "manual" | "local-event" | "focus-resume" | "config-change" | "stale" | "retry" | "remote-change";
export type SchedulerState = "idle" | "debouncing" | "running" | "rerun-pending" | "blocked-by-auth";
export type FailureClass = "retryable" | "stable" | "auth";
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
  loadPrevious(): Promise<Map<string, PreviousEntry>>;
  filterPrevious(entries: Map<string, PreviousEntry>): Map<string, PreviousEntry>;
  buildPlan(local: Map<string, LocalEntry>, remote: Map<string, RemoteEntry>, previous: Map<string, PreviousEntry>): SyncPlan;
  execute(operation: SyncOperation): Promise<OperationResult>;
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
  notifyRemoteDirty(): Promise<{ ok: true; generation: string } | { ok: false; kind: string }>;
}

export interface SchedulerDependencies {
  captureCycle(): CycleDependencies;
  visible(): boolean;
  remoteChange?: SchedulerRemoteChange;
  timers?: SchedulerTimers;
  onStatus?(state: SchedulerState, counts: ResultCounts): void;
  debug?(message: string): void;
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
