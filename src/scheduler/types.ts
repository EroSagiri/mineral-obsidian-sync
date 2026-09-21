import type { OperationResult } from "../sync/executor";
import type { LocalEntry, PreviousEntry, RemoteEntry, SyncOperation, SyncPlan } from "../sync/types";

export type ReconcileReason = "startup" | "local-event" | "focus-resume" | "config-change" | "stale" | "retry" | "remote-change";
export type SchedulerState = "idle" | "debouncing" | "running" | "rerun-pending" | "blocked-by-auth";
export type FailureClass = "retryable" | "stable" | "auth";
export type ResultKind = OperationResult["status"] | "conflict" | "noop";
export type ResultCounts = Record<ResultKind, number>;

export interface SchedulerTimers {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export interface CycleDependencies {
  scanLocal(): Map<string, LocalEntry>;
  scanRemote(): Promise<Map<string, RemoteEntry>>;
  loadPrevious(): Promise<Map<string, PreviousEntry>>;
  filterPrevious(entries: Map<string, PreviousEntry>): Map<string, PreviousEntry>;
  buildPlan(local: Map<string, LocalEntry>, remote: Map<string, RemoteEntry>, previous: Map<string, PreviousEntry>): SyncPlan;
  execute(operation: SyncOperation): Promise<OperationResult>;
}

export interface SchedulerDependencies {
  captureCycle(): CycleDependencies;
  visible(): boolean;
  timers?: SchedulerTimers;
  onStatus?(state: SchedulerState, counts: ResultCounts): void;
  debug?(message: string): void;
}

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
}
