/**
 * Read-only three-way diagnostic: R2 vs the Windows vault vs the Android vault.
 *
 * Reuses the product's real SigV4 signing, real `R2Client` LIST path (over Node fetch) and the real
 * ignore rules, so it reports the same key space the planner sees. It performs **no writes**.
 *
 * Usage:
 *   node scripts/vault-diff.mjs <windowsVaultDir> <androidListingFile> [--content-only]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { SignedR2ListClient } from "../build-diag/diag.mjs";
import { NodeFetchTransport } from "./node-fetch-transport.mjs";

const [, , windowsVault, androidListing] = process.argv;
const contentOnly = process.argv.includes("--content-only");
if (!windowsVault || !androidListing) {
  console.error("usage: node scripts/vault-diff.mjs <windowsVaultDir> <androidListingFile> [--content-only]");
  process.exit(2);
}

const dataJson = JSON.parse(readFileSync(join(windowsVault, ".obsidian", "plugins", "mineral-obsidian-sync", "data.json"), "utf8"));
const config = { endpoint: dataJson.endpoint, bucket: dataJson.bucket, accessKeyId: dataJson.accessKeyId, secretAccessKey: dataJson.secretAccessKey, remotePrefix: dataJson.remotePrefix ?? "" };

// Mirrors src/sync/ignore.ts: built-in exclusions plus configured paths and their descendants.
const PLUGIN_PREFIX = ".obsidian/plugins/mineral-obsidian-sync/";
const TEMPORARY_BASENAMES = new Set([".ds_store", "thumbs.db"]);
const configured = [...(dataJson.ignoredPaths ?? []), ...(dataJson.ignoredFolders ?? []), ...(dataJson.ignoredFiles ?? [])]
  .map((value) => String(value).trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean);

function canonicalKey(path) {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`bad path: ${path}`);
  return normalized;
}
function ignores(key) {
  const normalized = canonicalKey(key);
  const lower = normalized.toLowerCase();
  if (lower.startsWith(PLUGIN_PREFIX) || TEMPORARY_BASENAMES.has(lower.split("/").at(-1) ?? "") || lower.endsWith("~") || lower.endsWith(".tmp")) return true;
  return configured.some((path) => normalized === path || normalized.startsWith(`${path}/`));
}
// `.git` is never synced content and would drown the report; `--content-only` also drops `.obsidian`.
const excluded = (key) => key.startsWith(".git/") || (contentOnly && key.startsWith(".obsidian/")) || key === ".git";

function scanWindows(rootDir) {
  const entries = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) { walk(absolute); continue; }
      if (!entry.isFile()) continue;
      const key = relative(rootDir, absolute).split(sep).join("/");
      if (excluded(key) || ignores(key)) continue;
      entries.set(key, { size: statSync(absolute).size });
    }
  };
  walk(rootDir);
  return entries;
}

function scanAndroid(listingFile) {
  const entries = new Map();
  for (const line of readFileSync(listingFile, "utf8").split("\n")) {
    const separator = line.lastIndexOf("|");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const size = Number(line.slice(separator + 1));
    if (!Number.isFinite(size)) continue;
    let canonical;
    try { canonical = canonicalKey(key); } catch { continue; }
    if (excluded(canonical) || ignores(canonical)) continue;
    entries.set(canonical, { size });
  }
  return entries;
}

const client = new SignedR2ListClient(config, () => new Date(), undefined, new NodeFetchTransport());
const remoteEntries = new Map();
for (const entry of await client.listObjects()) if (!ignores(entry.key) && !excluded(entry.key)) remoteEntries.set(entry.key, entry);

const windows = scanWindows(windowsVault);
const android = scanAndroid(androidListing);
const allKeys = [...new Set([...remoteEntries.keys(), ...windows.keys(), ...android.keys()])].sort();
const pick = (predicate) => allKeys.filter(predicate);

const inR2NotAndroid = pick((key) => remoteEntries.has(key) && !android.has(key));
const inR2NotWindows = pick((key) => remoteEntries.has(key) && !windows.has(key));
const inAndroidNotR2 = pick((key) => !remoteEntries.has(key) && android.has(key));
const inWindowsNotR2 = pick((key) => !remoteEntries.has(key) && windows.has(key));
const inWindowsNotAndroid = pick((key) => windows.has(key) && !android.has(key));
const inAndroidNotWindows = pick((key) => android.has(key) && !windows.has(key));
const sizeMismatchAndroid = pick((key) => remoteEntries.has(key) && android.has(key) && remoteEntries.get(key).size !== android.get(key).size);
const sizeMismatchWindows = pick((key) => remoteEntries.has(key) && windows.has(key) && remoteEntries.get(key).size !== windows.get(key).size);

console.log(`mode                        : ${contentOnly ? "vault content only (no .obsidian, no .git)" : "everything except .git"}`);
console.log(`R2 objects (sync-eligible)  : ${remoteEntries.size}`);
console.log(`Windows files               : ${windows.size}`);
console.log(`Android files               : ${android.size}`);
console.log(`union of keys               : ${allKeys.length}`);
console.log("");
console.log(`in R2 but NOT on Android    : ${inR2NotAndroid.length}`);
console.log(`in R2 but NOT on Windows    : ${inR2NotWindows.length}`);
console.log(`on Android but NOT in R2    : ${inAndroidNotR2.length}`);
console.log(`on Windows but NOT in R2    : ${inWindowsNotR2.length}`);
console.log(`on Windows but NOT on Android: ${inWindowsNotAndroid.length}`);
console.log(`on Android but NOT on Windows: ${inAndroidNotWindows.length}`);
console.log(`size differs R2 vs Android  : ${sizeMismatchAndroid.length}`);
console.log(`size differs R2 vs Windows  : ${sizeMismatchWindows.length}`);
console.log("");
const sample = (name, list) => { if (list.length) console.log(`${name} (first 25):\n${list.slice(0, 25).map((key) => `  ${key}`).join("\n")}\n`); };
sample("in R2 but NOT on Android", inR2NotAndroid);
sample("on Android but NOT in R2", inAndroidNotR2);
sample("in R2 but NOT on Windows", inR2NotWindows);
sample("on Windows but NOT on Android", inWindowsNotAndroid);
sample("size differs R2 vs Android", sizeMismatchAndroid);
