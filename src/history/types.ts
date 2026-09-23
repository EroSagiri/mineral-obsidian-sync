/**
 * Sync history: what a sync actually did to a file, kept locally so the user can read it back and
 * recover an earlier version.
 *
 * History is *evidence*, never sync truth. Losing it costs a user the ability to look up or restore an
 * earlier version; it must never change what the sync engine decides. That is why every write through
 * `SyncHistoryStore` is best-effort at the call site, and why nothing here is read on the sync path.
 *
 * The store holds snapshots rather than diffs: a snapshot is what "restore this version" needs, and a
 * diff would have to be replayed against a baseline that may itself have been pruned.
 */

export type SyncHistoryEventType = "clean-auto-merge" | "handoff-auto-merge" | "manual-conflict-resolved" | "restore";

/** One version of one file, stored so it can be viewed and restored. */
export interface SyncHistorySnapshot {
  /** Normalised LF text, as the merge engine and conflict snapshots already use. */
  content: string;
  sha256: string;
  size: number;
  etag?: string;
  modified?: number;
}

/** Why an automatic merge was allowed, kept for later tuning of the policy. */
export interface SyncHistoryMetadata {
  branchSeparationMs?: number;
  branchAgeMs?: number;
  localDeltaBytes?: number;
  remoteDeltaBytes?: number;
  hunkCount?: number;
  mergeReason?: string;
  order?: string;
  /** For `manual-conflict-resolved`: which resolution the user chose. */
  resolutionType?: string;
  /** For `restore`: the history entry whose snapshot was restored. */
  sourceHistoryId?: string;
}

export interface SyncHistoryEntry {
  id: string;
  channel: string;
  path: string;
  type: SyncHistoryEventType;
  timestamp: number;
  base?: SyncHistorySnapshot;
  localBefore?: SyncHistorySnapshot;
  remoteBefore?: SyncHistorySnapshot;
  /** For `restore`, the content that was current immediately before the restore. */
  previousCurrent?: SyncHistorySnapshot;
  result: SyncHistorySnapshot;
  metadata: SyncHistoryMetadata;
}

export interface SyncHistoryStore {
  /** Records one entry, then applies retention to that channel. Rejects on a real write failure. */
  record(entry: SyncHistoryEntry): Promise<void>;
  /** Every entry of a channel, newest first. */
  list(channel: string): Promise<SyncHistoryEntry[]>;
  get(channel: string, id: string): Promise<SyncHistoryEntry | undefined>;
}
