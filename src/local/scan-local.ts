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
