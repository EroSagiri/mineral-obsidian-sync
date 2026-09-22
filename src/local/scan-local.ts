import type { Vault } from "obsidian";
import { canonicalKey } from "../sync/path";
import type { VaultPathFilter } from "../sync/ignore";
import type { LocalEntry } from "../sync/types";

export function scanLocal(vault: Vault, filter: VaultPathFilter): Map<string, LocalEntry> {
  const entries = new Map<string, LocalEntry>();
  for (const file of vault.getFiles()) {
    const key = canonicalKey(file.path);
    if (filter.ignores(key)) continue;
    entries.set(key, { key, size: file.stat.size, mtime: file.stat.mtime });
  }
  return entries;
}

/**
 * Reads file metadata through the adapter rather than TFile.stat. Android can retain a stale
 * in-memory TFile after it misses a Vault event, while the adapter still sees the saved bytes.
 */
export async function scanLocalAdapterMetadata(vault: Vault, filter: VaultPathFilter): Promise<Map<string, LocalEntry>> {
  const entries = new Map<string, LocalEntry>();
  for (const file of vault.getFiles()) {
    const key = canonicalKey(file.path);
    if (filter.ignores(key)) continue;
    const stat = await vault.adapter.stat(file.path);
    if (stat) entries.set(key, { key, size: stat.size, mtime: stat.mtime });
  }
  return entries;
}
