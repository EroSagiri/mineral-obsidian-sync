import type { LocalEntry } from "../sync/types";

/**
 * Android can occasionally omit Vault modification events while an editor remains open.
 * This intentionally compares only cheap file metadata; a remote reconciliation is
 * requested only after an observed local change.
 */
export function changedLocalKeys(previous: ReadonlyMap<string, LocalEntry>, current: ReadonlyMap<string, LocalEntry>): string[] {
  const changed = new Set<string>();
  for (const [key, entry] of current) {
    const prior = previous.get(key);
    if (!prior || prior.size !== entry.size || prior.mtime !== entry.mtime) changed.add(key);
  }
  for (const key of previous.keys()) if (!current.has(key)) changed.add(key);
  return [...changed];
}
