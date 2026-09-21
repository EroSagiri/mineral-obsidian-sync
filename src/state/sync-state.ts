import type { PreviousEntry } from "../sync/types";
export type { PreviousEntry } from "../sync/types";

export interface StateStore {
  loadAll(): Promise<Map<string, PreviousEntry>>;
  /** Writes only verified initial equality facts; it must never imply a transfer occurred. */
  saveVerified(entries: Map<string, PreviousEntry>): Promise<void>;
  /** Atomically commits one proven post-operation baseline, without replacing unrelated keys. */
  put(entry: PreviousEntry): Promise<void>;
  /** Reserved for a future successful real-sync commit. */
  saveAll(entries: Map<string, PreviousEntry>): Promise<void>;
}
