#!/usr/bin/env node
/**
 * One deployment entrypoint for both Obsidian targets.
 *
 *   node scripts/deploy.mjs --target windows            # desktop vault
 *   node scripts/deploy.mjs --target android --restart  # phone over ADB
 *   node scripts/deploy.mjs --dev --target android      # self-test bundle
 *   node scripts/deploy.mjs --dry-run                   # show the plan, touch nothing
 *
 * Every directory is supplied by the environment (see `.env.example`); the flags
 * below only exist to override an individual run. Nothing about a specific
 * machine, vault location or device is compiled in.
 *
 *   MINERAL_DEPLOY_* variables — read from the shell, then `.env` / `.env.local`
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULTS, expandPath, resolveDeployConfig } from "./lib/deploy-config.mjs";
import {
  DeployError,
  createAdb,
  createSourceResolver,
  formatBytes,
  rotationFolderName,
  sha256Hex,
  stageBundle,
} from "./lib/deploy-lib.mjs";
import { BUILD_ARTIFACT, buildBundle } from "./lib/build.mjs";
import { deployToAndroid, readLocalManifest } from "./targets/android.mjs";
import { deployToWindows } from "./targets/windows.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------------------------------
 * Output
 * ---------------------------------------------------------------------------------------*/

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
const log = (message = "") => process.stdout.write(`${message}\n`);
const step = (message) => log(`${paint(36, "▸")} ${message}`);
const ok = (message) => log(`${paint(32, "✓")} ${message}`);
const warn = (message) => log(`${paint(33, "!")} ${message}`);
const fail = (message) => process.stderr.write(`${paint(31, "✗")} ${message}\n`);

/* ------------------------------------------------------------------------------------------
 * Arguments
 * ---------------------------------------------------------------------------------------*/

const USAGE = `\
Usage: node scripts/deploy.mjs [options]

Options:
  --target <windows|android|auto>   Deployment target. Default: auto (windows on Windows).
  --vault <path|name>               Vault directory (Windows) or vault name (Android).
  --serial <device>                 ADB device serial (Android).
  --build <production|development>  Bundle mode. Default: production.
  --dev                             Shorthand for --build development.
  --skip-build                      Deploy the existing main.js (or dev bundle).
  --dry-run                         Print every action without building or writing.
  --force                           Push even when the device already has the same bytes.
  --rotate                          Install into a fresh plugin folder (Android default
                                    when --restart is on; see docs/hot-sync.md).
  --no-rotate                       Install into the plain "<pluginId>" folder.
  --prune                           Remove other enabled Android plugin folders that
                                    declare the same plugin id (destructive).
  --restart                         Restart Obsidian afterwards so the bundle loads.
  --create                          Create the plugin directory if it is missing (Windows).
  --suffix <none|hash|timestamp>    Report the content hash of what was deployed.
  --report [path]                   Write a JSON deployment report (default: last-deploy.json).
  -h, --help                        Show this help.

Environment (shell, then .env / .env.local):
  MINERAL_DEPLOY_WINDOWS_VAULT      Windows vault root, e.g. C:\\Users\\me\\vault
  MINERAL_DEPLOY_ANDROID_VAULT      Android vault name ("mineral") or absolute device path
  MINERAL_DEPLOY_ANDROID_SERIAL     ADB serial; auto-detected when exactly one device is attached
  MINERAL_DEPLOY_ADB                adb executable (default: adb on PATH)
  MINERAL_DEPLOY_PLUGIN_ID          Plugin id / folder name (default: ${DEFAULTS.pluginId})
  MINERAL_DEPLOY_PLUGIN_FILES       Space/comma separated artifact list
  MINERAL_DEPLOY_ANDROID_PACKAGE    Obsidian package id (default: ${DEFAULTS.androidPackage})
  MINERAL_DEPLOY_ANDROID_ACTIVITY   Explicit launch component (default: launcher intent)
  MINERAL_DEPLOY_BUILD              production | development
  MINERAL_DEPLOY_DEV_BUNDLE         Development bundle output path
  MINERAL_DEPLOY_ROTATE_PLUGIN_DIR  true | false
  MINERAL_DEPLOY_RESTART_OBSIDIAN   true | false
  MINERAL_DEPLOY_KILL_OBSIDIAN      Stop the desktop app before copying
  MINERAL_DEPLOY_SKIP_BUILD         true | false
  MINERAL_DEPLOY_DRY_RUN            true | false
  MINERAL_DEPLOY_TARGET             windows | android | auto
`;

function parseArguments(argv) {
  const flags = { report: false, suffix: "none" };
  const demand = (name, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new DeployError(`${name} requires a value.\n\n${USAGE}`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--target": flags.target = demand(arg, index).toLowerCase(); index += 1; break;
      case "--vault": flags.vault = demand(arg, index); index += 1; break;
      case "--serial": case "-s": flags.serial = demand(arg, index); index += 1; break;
      case "--build": flags.build = demand(arg, index).toLowerCase(); index += 1; break;
      case "--dev": case "--development": flags.build = "development"; break;
      case "--skip-build": flags.skipBuild = true; break;
      case "--dry-run": case "-n": flags.dryRun = true; break;
      case "--force": flags.force = true; break;
      case "--rotate": flags.rotate = true; break;
      case "--no-rotate": flags.rotate = false; break;
      case "--prune": flags.prune = true; break;
      case "--restart": flags.restart = true; break;
      case "--no-restart": flags.restart = false; break;
      case "--create": flags.create = true; break;
      case "--suffix": {
        const value = demand(arg, index).toLowerCase();
        if (!["none", "hash", "timestamp"].includes(value)) {
          throw new DeployError(`--suffix expects none, hash or timestamp (got "${value}").`);
        }
        flags.suffix = value;
        index += 1;
        break;
      }
      case "--report": {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) {
          flags.report = "last-deploy.json";
        } else {
          flags.report = next;
          index += 1;
        }
        break;
      }
      case "-h": case "--help": log(USAGE); process.exit(0); break;
      default:
        throw new DeployError(`unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return flags;
}

/* ------------------------------------------------------------------------------------------
 * Main
 * ---------------------------------------------------------------------------------------*/

async function main() {
  const flags = parseArguments(process.argv.slice(2));
  const repoHas = (name) => existsSync(join(ROOT, name));

  const config = resolveDeployConfig({
    root: ROOT,
    target: flags.target ?? "auto",
    overrides: {
      target: flags.target,
      vault: flags.vault,
      serial: flags.serial,
      build: flags.build,
      skipBuild: flags.skipBuild,
      dryRun: flags.dryRun,
      rotate: flags.rotate,
      prune: flags.prune,
      restart: flags.restart,
      create: flags.create,
      force: flags.force,
    },
    repoHas,
  });

  const started = Date.now();
  log("");
  log(paint(1, `Mineral Obsidian Sync — deploy (${config.target})`));
  log(`Repository    : ${ROOT}`);
  if (config.dryRun) warn("Dry run: nothing will be written, pushed or restarted.");
  log("");

  const manifest = readLocalManifest(ROOT);
  if (manifest) log(`Plugin        : ${manifest.name ?? config.pluginId} v${manifest.version ?? "?"} (${manifest.id ?? config.pluginId})`);

  // --- build ------------------------------------------------------------------------------
  const production = config.build.mode === "production";
  let bundlePath = join(ROOT, production ? BUILD_ARTIFACT : config.build.devFile);
  if (config.build.skip) {
    step(`Skipping build; using existing ${bundlePath}`);
    if (!existsSync(bundlePath) && !config.dryRun) {
      throw new DeployError(`no prebuilt bundle at ${bundlePath}; drop --skip-build.`);
    }
  } else if (config.dryRun) {
    step(`[dry-run] would build the ${config.build.mode} bundle`);
  } else {
    step(`Build mode: ${config.build.mode}`);
    bundlePath = await buildBundle({ root: ROOT, production, log });
    ok(`Bundle        : ${bundlePath} (${formatBytes(statSync(bundlePath).size)})`);
  }

  // A development bundle lands in build-diag/; the deployed filename is always
  // main.js, so the vault layout is identical in both modes.
  let stagedBundle = null;
  if (!production && !config.dryRun && !config.build.skip) {
    const stagingDir = join(ROOT, "build-diag", "staged");
    stagedBundle = stageBundle({ source: bundlePath, stagingDir, suffix: flags.suffix });
    if (stagedBundle.name !== "main.js") {
      log(`Staged        : ${stagedBundle.name} (SHA-256 ${stagedBundle.hash.slice(0, 12)}…)`);
    }
  }
  const deployBundle = stagedBundle?.path ?? bundlePath;
  const sourceFor = createSourceResolver(ROOT, deployBundle);
  const bundleInfo = {
    mode: config.build.mode,
    file: basename(deployBundle),
    path: deployBundle,
    sha256: config.dryRun ? null : sha256Hex(deployBundle),
  };

  // --- deploy -----------------------------------------------------------------------------
  let report;
  if (config.target === "windows") {
    report = await deployToWindows(config, { log, warn, sourceFor });
  } else {
    const adb = createAdb({
      executable: config.android.adb,
      serial: config.android.serial,
      timeoutMs: config.android.timeoutMs,
    });
    adb.version();
    const serial = config.dryRun && config.android.serial ? config.android.serial : adb.resolveSerial();
    const boundAdb = createAdb({ executable: config.android.adb, serial, timeoutMs: config.android.timeoutMs });

    const installDirName = resolveInstallFolder(config, manifest);
    report = await deployToAndroid(config, { adb: boundAdb, log, warn, installDirName, sourceFor });
  }

  // --- summary ----------------------------------------------------------------------------
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  log("");
  if (config.dryRun) {
    log(paint(1, `Dry run complete in ${elapsed}s — nothing was changed.`));
  } else {
    ok(`${config.target} deployment complete in ${elapsed}s`);
    if (report?.pluginDir) log(`   ${report.pluginDir}`);
    if (config.target === "windows" && !config.restart) {
      log("   Reload the plugin (or restart Obsidian) before testing this bundle.");
    }
    if (config.target === "android" && !config.restart) {
      log("   Restart Obsidian on the device before testing this bundle.");
    }
  }

  // --- report -----------------------------------------------------------------------------
  const reportPath = flags.report
    ? expandPath(flags.report === true ? "last-deploy.json" : flags.report, ROOT)
    : null;
  if (reportPath && !config.dryRun) {
    const payload = {
      schema: "mineral-obsidian-sync/deploy-report@1",
      when: new Date().toISOString(),
      durationSeconds: Number(elapsed),
      target: config.target,
      build: config.build.mode,
      bundle: bundleInfo,
      plugin: { id: config.pluginId, version: manifest?.version ?? null },
      ...report,
    };
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    log(`   Report: ${reportPath}`);
  }
  return 0;
}

/**
 * Which plugin folder the bundle goes into.
 *
 * `--rotate` installs into a fresh, uniquely named folder. This is required for
 * Android in practice: Obsidian keys loaded plugins by folder path, so overwriting
 * `main.js` in place leaves the old code running until the plugin is manually
 * disabled and re-enabled (see docs/hot-sync.md). Rotation is therefore the
 * default for Android when a restart was requested, and can be forced either way.
 */
function resolveInstallFolder(config, manifest) {
  if (!config.rotate) return config.pluginId;
  const folder = rotationFolderName(config.pluginId, manifest?.version);
  step(`Rotate        : ${config.dryRun ? "[dry-run] would install into " : "new plugin folder "}${folder}`);
  return folder;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    if (error instanceof DeployError) {
      fail(error.message);
      process.exit(error.code);
    }
    fail(error?.stack ?? String(error));
    process.exit(1);
  });
