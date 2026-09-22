import type { LocalEntry } from "../sync/types";

/**
 * Conflict resolution state: the merge-base snapshot, the active conflict records, and the
 * resolution intents a user (or a clean auto-merge) has produced.
 *
 * Three separate concerns, deliberately kept in separate stores:
 *
 * - the merge base is an *optimization / conflict facility*; losing it costs merge ability, never
 *   correctness;
 * - a conflict record is *observation state* about a disagreement;
 * - a resolution intent is a *proposal* that the planner may or may not accept.
 *
 * None of them is sync truth: `previous` state and R2 remain the only authorities.
 */

export const CONFLICT_PROTOCOL_VERSION = 1;

/** Which previous baseline a snapshot belongs to. Both halves must match or the snapshot is void. */
export interface BaselineIdentity {
  localVersion: LocalEntry;
  remoteETag?: string;
}

export interface MergeBaseRecord {
  protocolVersion: typeof CONFLICT_PROTOCOL_VERSION;
  channel: string;
  path: string;
  /** Proof that this snapshot corresponds to that `previous` baseline, not merely to that path. */
  baseline: BaselineIdentity;
  sha256: string;
  byteLength: number;
  encoding: { bom: boolean; eol: "lf" | "crlf" | "mixed"; trailingNewline: boolean };
  /** Normalized (LF, no BOM) text. Only ever stored for mergeable text under the size ceiling. */
  content: string;
  updatedAt: number;
}

export type AutoMergeStatus = "not-attempted" | "clean" | "manual-required" | "base-unavailable" | "unsupported" | "too-large" | "decode-failed";

export interface ConflictRecord {
  protocolVersion: typeof CONFLICT_PROTOCOL_VERSION;
  conflictId: string;
  channel: string;
  path: string;
  /** The baseline the disagreement is measured against. */
  previous: BaselineIdentity;
  observedLocal: LocalEntry;
  observedRemoteETag?: string;
  detectedAt: number;
  autoMergeStatus: AutoMergeStatus;
  reason?: string;
  /** Bounded snapshots for the resolver UI; refreshed on each detection, never accumulated. */
  snapshot: { local?: string; remote?: string; base?: string; draft?: string; baseAvailable: boolean };
}

export type ResolutionIntentType = "keep-local" | "keep-remote" | "merged";

/**
 * A resolution is an explicit, version-bound proposal. It is never a mutation: the UI only ever
 * writes one of these, and the planner decides whether it is still applicable.
 */
export interface ResolutionIntent {
  protocolVersion: typeof CONFLICT_PROTOCOL_VERSION;
  conflictId: string;
  channel: string;
  path: string;
  type: ResolutionIntentType;
  expectedLocalVersion: LocalEntry;
  expectedRemoteETag?: string;
  createdAt: number;
  /** Present for `merged`: the exact bytes the user or the auto-merge wants to become the truth. */
  merged?: { content: string; sha256: string; encoding: { bom: boolean; eol: "lf" | "crlf" | "mixed"; trailingNewline: boolean } };
}

export interface MergeBaseStore {
  get(channel: string, path: string): Promise<MergeBaseRecord | undefined>;
  put(record: MergeBaseRecord): Promise<void>;
  /** Removal is scoped to a channel and its paths; used when a key is gone on both sides. */
  remove(channel: string, paths: string[]): Promise<void>;
  /** Bounded eviction so the store cannot grow without limit. */
  prune(channel: string, maxRecords: number): Promise<void>;
}

export interface ConflictStore {
  listConflicts(channel: string): Promise<ConflictRecord[]>;
  getConflict(channel: string, conflictId: string): Promise<ConflictRecord | undefined>;
  putConflict(record: ConflictRecord): Promise<void>;
  removeConflicts(channel: string, conflictIds: string[]): Promise<void>;
  /**
   * Drops records for paths that are no longer in conflict, and any record whose baseline no longer
   * matches the current one. Only active conflicts are ever retained.
   */
  reconcile(channel: string, active: Map<string, string>): Promise<void>;
}

export interface ResolutionIntentStore {
  listIntents(channel: string): Promise<ResolutionIntent[]>;
  putIntent(intent: ResolutionIntent): Promise<void>;
  removeIntents(channel: string, conflictIds: string[]): Promise<void>;
}
