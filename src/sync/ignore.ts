import { canonicalKey } from "./path";

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
/** Dev-only diagnostics live outside the product namespace and may be invisible to Obsidian indexing. */
const INTEGRATION_TEST_PREFIXES = [".mineral-sync-test/", "private/mineral-sync-test-local/"];
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
      if (lower.startsWith(PLUGIN_PREFIX) || INTEGRATION_TEST_PREFIXES.some((path) => lower.startsWith(path)) || TEMPORARY_BASENAMES.has(lower.split("/").at(-1) ?? "") || lower.endsWith("~") || lower.endsWith(".tmp")) return true;
      return [...paths].some((path) => normalized === path || normalized.startsWith(`${path}/`));
    },
  };
}
