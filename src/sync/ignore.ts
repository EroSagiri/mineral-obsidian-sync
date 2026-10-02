import { canonicalKey } from "./path";
import { isSystemStorageKey } from "@mineral/sync-core/storage";

export interface IgnoreRules {
  ignoredPaths: string[];
}

export interface VaultPathFilter {
  ignores(key: string): boolean;
}

/** Stable policy marker: any ignore-policy edit invalidates old deletion-inference baselines. */
export function ignorePolicyFingerprint(rules: IgnoreRules): string {
  return JSON.stringify([...new Set(rules.ignoredPaths.map(configuredPath).filter((path): path is string => Boolean(path)))].sort());
}

const PLUGIN_PREFIX = ".obsidian/plugins/mineral-obsidian-sync/";
/**
 * The integration harness's scratch roots.
 *
 * The harness runs inside a real vault, and on Android it *has* to: Obsidian refuses to index a
 * dot-directory at the vault root, so a self-test that only used hidden paths could not open a file in
 * an editor there at all. Its files are therefore visible — which means the sync engine would otherwise
 * treat them as the user's notes and upload them. These prefixes are the reason it does not.
 */
const INTEGRATION_PREFIXES = ["private/mineral-sync-test-local/", "private/mineral-sync-hot-selftest/"];
const TEMPORARY_BASENAMES = new Set([".ds_store", "thumbs.db"]);

function configuredPath(value: string): string | undefined {
  const trimmed = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!trimmed) return undefined;
  try { return canonicalKey(trimmed); } catch { return undefined; }
}

/** Applies built-in safety exclusions plus user-provided paths and their descendants. */
export function createVaultPathFilter(rules: IgnoreRules): VaultPathFilter {
  const paths = new Set(rules.ignoredPaths.map(configuredPath).filter((path): path is string => Boolean(path)));
  return {
    ignores(key: string): boolean {
      const normalized = canonicalKey(key);
      const lower = normalized.toLowerCase();
      if (lower.startsWith(PLUGIN_PREFIX) || isSystemStorageKey(lower) || INTEGRATION_PREFIXES.some(prefix => lower.startsWith(prefix)) || TEMPORARY_BASENAMES.has(lower.split("/").at(-1) ?? "") || lower.endsWith("~") || lower.endsWith(".tmp")) return true;
      return [...paths].some((path) => normalized === path || normalized.startsWith(`${path}/`));
    },
  };
}
