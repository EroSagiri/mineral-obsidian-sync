/**
 * Deployment configuration: every directory, device selector and toggle used by
 * `scripts/deploy.mjs` comes from the environment, never from a hard-coded path.
 *
 * Sources, in precedence order (first non-empty wins):
 *
 *   1. CLI flags                      --vault <path>, --serial <id>, ...
 *   2. the shell environment          $env:MINERAL_DEPLOY_ANDROID_VAULT = "..."
 *   3. `.env` / `.env.local`          MINERAL_DEPLOY_ANDROID_VAULT=...
 *   4. built-in defaults              plugin id, file list, timings
 *
 * Flags win so a one-off override never has to edit a file; the shell environment
 * wins over `.env` so CI can inject a machine-specific vault without touching the
 * checked-in template. `.env` is git-ignored; `.env.example` is the public template.
 *
 * The grammar of `.env` is deliberately tiny (KEY=VALUE, `#` comments, optional
 * surrounding quotes) — the same reader `scripts/vendor-sync-core.mjs` uses. No
 * `dotenv` dependency is added for one script.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/* ------------------------------------------------------------------------------------------
 * .env reader
 * ---------------------------------------------------------------------------------------*/

/** Parse one `.env`-style file into a plain object; missing/unreadable yields `{}`. */
function parseEnvFile(path) {
  const result = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return result;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // A trailing ` # comment` is not stripped: a path may legitimately contain `#`.
    result[key] = value;
  }
  return result;
}

const dotEnvCache = new Map();

/**
 * Read `.env` then `.env.local` from `dir`; the later file wins per key, mirroring
 * the "last assignment wins" rule of the vendor script.
 */
export function readDotEnv(dir) {
  const cached = dotEnvCache.get(dir);
  if (cached) return cached;
  const merged = {};
  for (const name of [".env", ".env.local"]) {
    const path = join(dir, name);
    if (existsSync(path)) Object.assign(merged, parseEnvFile(path));
  }
  dotEnvCache.set(dir, merged);
  return merged;
}

/* ------------------------------------------------------------------------------------------
 * Value helpers
 * ---------------------------------------------------------------------------------------*/

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled", ""]);

/**
 * A config reader bound to one `.env` snapshot. `get("SUFFIX")` looks for the
 * `MINERAL_DEPLOY_`-prefixed key in the shell environment first, then in `.env`.
 */
function createReader(dotEnv) {
  return function get(suffix) {
    const key = `MINERAL_DEPLOY_${suffix}`;
    const fromShell = process.env[key];
    if (typeof fromShell === "string" && fromShell.trim() !== "") return fromShell.trim();
    const fromFile = dotEnv[key];
    if (typeof fromFile === "string" && fromFile.trim() !== "") return fromFile.trim();
    return undefined;
  };
}

/**
 * Expand `~` and `%VAR%` / `$VAR` references, then make the path absolute against
 * `baseDir`. Used for every user-supplied directory so a vault may be written
 * either absolutely or relative to the repository root.
 */
export function expandPath(value, baseDir) {
  let text = String(value).trim();
  if (text === "") throw new Error("empty path");
  if (text === "~") text = homedir();
  else if (text.startsWith("~/") || text.startsWith("~\\")) text = join(homedir(), text.slice(2));
  text = text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) =>
    process.env[name] ?? process.env[name.toUpperCase()] ?? match,
  );
  text = text.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (match, name) => process.env[name] ?? match);
  return isAbsolute(text) ? resolve(text) : resolve(baseDir, text);
}

/** `"yes"` / `"0"` / undefined → boolean, with an explicit default. */
export function toBool(value, fallback) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

/** `"30"` → 30; anything unparsable falls back. */
export function toInt(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** A comma/whitespace/semicolon separated list → trimmed array. */
export function toList(value) {
  if (value === undefined) return [];
  return String(value)
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function splitDevicePath(value) {
  const text = String(value).trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (text === "") throw new Error("empty device path");
  if (text.startsWith("/storage/") || text.startsWith("/sdcard")) {
    const segments = text.replace(/^\/(storage\/emulated\/\d+|sdcard)\/?/, "").split("/").filter(Boolean);
    return { androidRoot: "storage", segments };
  }
  return { androidRoot: "sdcard", segments: text.replace(/^\//, "").split("/").filter(Boolean) };
}

/**
 * Accepts either `mineral` (recommended — resolved below `/sdcard/Documents/`,
 * which is what the Obsidian file picker on the device calls `Documents`) or an
 * absolute device path such as `/storage/emulated/0/Documents/mineral`.
 */
export function parseAndroidVault(value) {
  const { androidRoot, segments } = splitDevicePath(value);
  if (segments.length === 0) throw new Error(`cannot parse Android vault path: ${value}`);
  const vaultName = segments[segments.length - 1];
  const rootBase = androidRoot === "storage" ? "/storage/emulated/0" : "/sdcard";
  const vaultRoot =
    segments[0] === "Documents" && segments.length > 1
      ? `${rootBase}/${segments.join("/")}`
      : `${rootBase}/Documents/${segments.join("/")}`;
  return { vaultName, vaultRoot, androidRoot };
}

/* ------------------------------------------------------------------------------------------
 * Config assembly
 * ---------------------------------------------------------------------------------------*/

export const DEFAULTS = Object.freeze({
  pluginId: "mineral-obsidian-sync",
  pluginFiles: ["main.js", "manifest.json"],
  androidDocuments: "/sdcard/Documents",
  androidPackage: "md.obsidian",
  adb: "adb",
  registryFile: "community-plugins.json",
  vaultSubdir: ".obsidian",
  deviceSetTimeoutMs: 120_000,
});

/** Files copied from the repository root into the plugin directory by default. */
function resolvePluginFiles(get, manifest) {
  const listed = toList(get("PLUGIN_FILES"));
  if (listed.length > 0) return listed;
  // `styles.css` and `data.json` are optional: ship them when the repo has them.
  const optional = ["styles.css"];
  const files = [...DEFAULTS.pluginFiles];
  for (const name of optional) {
    if (manifest.repoHas(name) && !files.includes(name)) files.push(name);
  }
  return files;
}

function resolveBuildMode(get, overrides) {
  const requested = (overrides.build ?? get("BUILD") ?? "production").toLowerCase();
  if (requested !== "production" && requested !== "development" && requested !== "dev") {
    throw new Error(`unknown build mode "${requested}"; expected production or development`);
  }
  return requested === "production" ? "production" : "development";
}

/**
 * Build the immutable deployment configuration.
 *
 * @param {object} options
 * @param {string} options.root        Repository root (absolute).
 * @param {string} options.target      `windows` | `android` | `auto`.
 * @param {object} [options.overrides] CLI flags; highest precedence.
 * @param {(name: string) => boolean} [options.repoHas] Repository probe for optional files.
 */
export function resolveDeployConfig({ root, target, overrides = {}, repoHas = () => false }) {
  const dotEnv = readDotEnv(root);
  const get = createReader(dotEnv);
  const manifest = { repoHas };
  const notes = [];

  const pluginId = overrides.pluginId ?? get("PLUGIN_ID") ?? DEFAULTS.pluginId;
  const pluginFiles = overrides.files ?? resolvePluginFiles(get, manifest);
  const buildMode = resolveBuildMode(get, overrides);
  const build = {
    mode: buildMode,
    skip: overrides.skipBuild ?? toBool(get("SKIP_BUILD"), false),
    // Where a development build lives. It is deliberately not `main.js`: the
    // debug bundle must never be able to overwrite the shipped artifact by
    // accident, and `--dev --skip-build` has to find it without being told.
    devFile: get("DEV_BUNDLE") ?? "build-diag/main-dev.js",
  };

  const requestedTarget = (overrides.target ?? get("TARGET") ?? target ?? "auto").toLowerCase();
  const windowsOverride = get("WINDOWS");
  const androidOverride = get("ANDROID");
  const resolvedTarget =
    requestedTarget === "auto"
      ? process.platform === "win32" || toBool(windowsOverride, false)
        ? "windows"
        : "android"
      : requestedTarget;
  if (resolvedTarget !== "windows" && resolvedTarget !== "android") {
    throw new Error(`unknown target "${resolvedTarget}"; expected windows, android or auto`);
  }

  const common = {
    root,
    pluginId,
    pluginFiles,
    build,
    target: resolvedTarget,
    dryRun: overrides.dryRun ?? toBool(get("DRY_RUN"), false),
    configFile: dotEnv,
  };

  if (resolvedTarget === "windows") {
    // `MINERAL_DEPLOY_WINDOWS_VAULT` is the exact vault directory (Obsidian may
    // call it anything, so no subdirectory is assumed); the generic
    // `MINERAL_DEPLOY_VAULT` is honoured as a shared fallback for one-vault setups.
    const rawVault = overrides.vault ?? get("WINDOWS_VAULT") ?? get("VAULT");
    if (!rawVault) {
      throw new Error(
        "Windows vault directory is not configured. Set MINERAL_DEPLOY_WINDOWS_VAULT " +
          "(or MINERAL_DEPLOY_VAULT) in .env, or pass --vault <path>.",
      );
    }
    const vault = expandPath(rawVault, root);
    const pluginDir = join(vault, DEFAULTS.vaultSubdir, "plugins", pluginId);
    return Object.freeze({
      ...common,
      platform: "windows",
      vault,
      vaultRoot: vault,
      pluginDir,
      registryPath: join(vault, DEFAULTS.vaultSubdir, DEFAULTS.registryFile),
      restart: overrides.restart ?? toBool(get("RESTART_OBSIDIAN"), false),
      mustExit: toBool(get("KILL_OBSIDIAN"), false),
      create: overrides.create ?? toBool(get("CREATE_PLUGIN_DIR"), false),
      processName: get("OBSIDIAN_PROCESS") ?? "Obsidian",
      notes,
    });
  }

  // Android: the vault lives on the device, so the directory is a POSIX path and
  // the repository path is irrelevant. `MINERAL_DEPLOY_ANDROID_VAULT` may be a
  // bare vault name (`mineral`) or an absolute device path.
  const rawVault = overrides.vault ?? get("ANDROID_VAULT") ?? get("VAULT");
  if (!rawVault) {
    throw new Error(
      "Android vault is not configured. Set MINERAL_DEPLOY_ANDROID_VAULT " +
        "(e.g. `mineral`) in .env, or pass --vault <name>.",
    );
  }
  const { vaultName, vaultRoot } = parseAndroidVault(rawVault);
  const pluginDir = `${vaultRoot}/${DEFAULTS.vaultSubdir}/plugins/${pluginId}`;
  const restart = overrides.restart ?? toBool(get("RESTART_OBSIDIAN"), false);
  // Rotating the plugin directory is the only reliable way to make Android
  // Obsidian execute a freshly pushed bundle (folder path is the cache key), so
  // it is the default whenever a restart was asked for. `--no-rotate` opts out.
  const rotate = overrides.rotate ?? toBool(get("ROTATE_PLUGIN_DIR"), restart);
  const android = {
    adb: get("ADB") ?? DEFAULTS.adb,
    packageName: get("ANDROID_PACKAGE") ?? DEFAULTS.androidPackage,
    serial: overrides.serial ?? get("ANDROID_SERIAL") ?? get("SERIAL") ?? null,
    activity: get("ANDROID_ACTIVITY") ?? null,
    timeoutMs: toInt(get("TIMEOUT_MS"), DEFAULTS.deviceSetTimeoutMs),
    // Absolute on the device: `.obsidian/community-plugins.json`, no `plugins/`.
    registryPath: `${vaultRoot}/${DEFAULTS.vaultSubdir}/${DEFAULTS.registryFile}`,
  };

  return Object.freeze({
    ...common,
    platform: "android",
    vault: vaultName,
    vaultName,
    vaultRoot,
    pluginDir,
    android,
    rotate,
    // Remove other enabled folders that declare the same plugin id. Off by
    // default: it deletes directories, so it must be an explicit choice.
    prune: overrides.prune ?? toBool(get("PRUNE_DUPLICATE_FOLDERS"), false),
    restart,
    notes,
  });
}
