import type { PreviousEntry } from "../sync/types";
export type { PreviousEntry } from "../sync/types";

export interface StateStore {
  loadAll(): Promise<Map<string, PreviousEntry>>;
  /** Writes only verified initial equality facts; it must never imply a transfer occurred. */
  saveVerified(entries: Map<string, PreviousEntry>): Promise<void>;
  /** Atomically commits one proven post-operation baseline, without replacing unrelated keys. */
  put(entry: PreviousEntry): Promise<void>;
  /**
   * Removes one baseline entry.
   *
   * This is **device-local bookkeeping only**: it never touches a Vault file or an R2 object. It is
   * used when a key is provably absent on both sides, so keeping its baseline would leave a
   * permanent, unresolvable footprint in the plan. Distinct from any product "delete" semantics.
   */
  delete(key: string): Promise<void>;
  /** Reserved for a future successful real-sync commit. */
  saveAll(entries: Map<string, PreviousEntry>): Promise<void>;
}
