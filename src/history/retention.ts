/**
 * Retention policy for the sync history store.
 *
 * Both limits exist for different failure modes: the age limit keeps a vault that is edited rarely
 * from showing a stale year of history, and the count limit keeps a vault edited constantly from
 * growing the local database without bound. Keeping the constants here means the store and any future
 * settings UI cannot disagree about them.
 */

export const SYNC_HISTORY_RETENTION_DAYS = 30;
export const SYNC_HISTORY_MAX_ENTRIES = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ordering shared by `list` and by retention, deliberately in one place.
 *
 * `list` promises newest first, and retention keeps "the newest N": if the two used different
 * comparators, an entry could be listed as recent yet be pruned, or survive as beyond the limit. Two
 * entries can share a millisecond, so `id` breaks the tie and the order never depends on input order.
 */
export function byNewestFirst(left: { id: string; timestamp: number }, right: { id: string; timestamp: number }): number {
  if (left.timestamp !== right.timestamp) return right.timestamp - left.timestamp;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Ids that must be dropped: older than the age limit, or beyond the newest N.
 *
 * Newest-first input is not assumed, and the result is deterministic for any permutation of the same
 * entries. The age comparison is strict, so an entry exactly at the cutoff is still retained.
 */
export function expiredHistoryIds(entries: readonly { id: string; timestamp: number }[], now: number): string[] {
  const cutoff = now - SYNC_HISTORY_RETENTION_DAYS * DAY_MS;
  const ordered = [...entries].sort(byNewestFirst);
  const expired: string[] = [];
  const seen = new Set<string>();
  ordered.forEach((entry, rank) => {
    if (rank < SYNC_HISTORY_MAX_ENTRIES && entry.timestamp >= cutoff) return;
    // A duplicated id would otherwise be reported twice and deleted twice.
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    expired.push(entry.id);
  });
  return expired;
}
