/**
 * Android deployment over ADB.
 *
 * Why this is not a one-line `adb push`: two device-specific traps are handled here.
 *
 *   1. A new `main.js` dropped into an existing plugin directory does **not**
 *      change the code Obsidian runs — plugins are keyed by directory path, and
 *      the loaded bundle is cached per path (see `docs/hot-sync.md`, "部署坑").
 *      `--rotate` installs into a fresh `<pluginId>-deploy-<version>-<stamp>/`
 *      directory and repoints `community-plugins.json`, which is the only
 *      reliable way to make the device execute the new build.
 *   2. The device shell is not a general POSIX host: hashing tools differ and the
 *      WebView debugging socket can accept a write without reporting completion.
 *      Every push therefore lands on a `.tmp` sibling, is verified by hash, and is
 *      only then `mv`-ed into place — a failed deploy never leaves a half bundle.
 *
 * Every path comes from configuration; nothing about the vault or the plugin
 * directory is hard-coded here.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { DeployError, formatBytes, readJsonFile, sha256Hex } from "../lib/deploy-lib.mjs";

/**
 * `community-plugins.json` sits directly in `.obsidian/`, while plugin folders
 * live in its `plugins/` child — a distinction that is easy to get wrong and
 * silently matches nothing, so it is derived in exactly one place.
 */
function pluginsRootOf(registryPath) {
  return `${dirname(registryPath)}/plugins`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Entry names directly inside a device directory; empty when it does not exist. */
function listFolderNames(adb, directory) {
  if (!adb.isDirectory(directory)) return [];
  const listing = adb.shell(`ls -1 '${directory}' 2>/dev/null`);
  if (!listing.ok) return [];
  return listing.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Which folder name `community-plugins.json` currently points at for this plugin id.
 *
 * The registry stores *directory* names, which usually equal the plugin id but not
 * after a rotation or a manual rename. Entries are therefore matched by comparing
 * the manifest's declared `id`, and an entry is only treated as active when its
 * directory actually exists on the device.
 */
function activeFolderFromRegistry(adb, registryPath, pluginId) {
  const text = adb.readFile(registryPath);
  if (text === null) return { list: null, folder: null, claimed: [] };
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return { list: null, folder: null, claimed: [] };
  }
  if (!Array.isArray(list)) return { list: null, folder: null, claimed: [] };

  const pluginsRoot = pluginsRootOf(registryPath);
  const claimed = [];
  const existsOnDevice = new Map();
  const directoryExists = (entry) => {
    let present = existsOnDevice.get(entry);
    if (present === undefined) {
      present = adb.isDirectory(`${pluginsRoot}/${entry}`);
      existsOnDevice.set(entry, present);
    }
    return present;
  };
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    // The canonical folder name is this plugin by definition — it must still be
    // *recorded* here, otherwise a registry entry for the plain folder looks like
    // it belongs to nobody and the previous install is never cleaned up.
    if (entry === pluginId) {
      claimed.push(entry);
      continue;
    }
    const manifest = adb.readFile(`${pluginsRoot}/${entry}/manifest.json`);
    if (!manifest) continue;
    try {
      if (JSON.parse(manifest).id === pluginId) claimed.push(entry);
    } catch {
      /* not our plugin */
    }
  }
  // The scanner this plugin replaced lives on under a different folder name in
  // some vaults, so registry order alone is not authority: prefer a folder that
  // both exists and is named after this plugin. A foreign-named folder is only
  // used when nothing else is installed, and is then left untouched.
  const existing = claimed.filter(directoryExists);
  const canonical = existing.find((entry) => entry === pluginId);
  const rotated = existing.find((entry) => entry.startsWith(`${pluginId}-`));
  const folder = canonical ?? rotated ?? existing[0] ?? null;
  return { list, folder, claimed, pluginsRoot };
}

/**
 * Folders on the device that declare this plugin id but are not the one we are
 * installing into. Two enabled folders with the same manifest id both load, which
 * produces duplicated commands and two copies of every event handler — worth
 * reporting, and removable with `--prune`.
 */
function findDuplicateFolders(adb, registryPath, pluginId, keep) {
  const { list, pluginsRoot } = activeFolderFromRegistry(adb, registryPath, pluginId);
  if (!Array.isArray(list)) return [];
  const pluginsRootResolved = pluginsRoot ?? pluginsRootOf(registryPath);
  const duplicates = [];
  for (const entry of list) {
    if (typeof entry !== "string" || entry === keep) continue;
    const manifest = adb.readFile(`${pluginsRootResolved}/${entry}/manifest.json`);
    if (!manifest) continue;
    try {
      if (JSON.parse(manifest).id === pluginId) duplicates.push(entry);
    } catch {
      /* not our plugin */
    }
  }
  return duplicates;
}

/**
 * Leftover rotation folders that should be retired.
 *
 * Rotation produces `<pluginId>-deploy-<version>-<stamp>` directories, and a
 * deploy that is interrupted, or a registry edited by hand, can strand one. Only
 * names this script itself generates are ever considered, so a folder a user named
 * (`mineral-sync13`, say) is never swept up here — that path goes through the
 * duplicate check and `--prune`, which reports before it removes.
 *
 * @param {string[]} entries      Directory names inside `<vault>/.obsidian/plugins`.
 * @param {string} pluginId
 * @param {string} keep           The folder being installed into.
 * @param {string[]} retire       Folders already scheduled for removal.
 * @param {(name: string) => boolean} isDirectory
 */
export function selectStaleDeployFolders(entries, pluginId, keep, retire, isDirectory) {
  const prefix = `${pluginId}-deploy-`;
  return entries
    .filter((name) => typeof name === "string" && name.startsWith(prefix))
    .filter((name) => name !== keep && !retire.includes(name))
    .filter((name) => isDirectory(name));
}

/**
 * Repoint `community-plugins.json` at `folderName`.
 *
 * The registry lists plugin *folder* names, and after a rotation the plugin's old
 * folder is still listed. The replacement happens in place so the enable/disable
 * order Obsidian stored is preserved, and exactly one entry describes this plugin
 * afterwards — `activeFolder` is the entry that was active before this deploy.
 */
function updateRegistry(adb, registryPath, list, folderName, pluginId, { dryRun, log, activeFolder }) {
  const next = Array.isArray(list) ? [...list] : [];
  const isOurs = (entry) =>
    typeof entry === "string" && (entry === pluginId || entry.startsWith(`${pluginId}-deploy-`));

  let changed = false;
  if (!next.includes(folderName)) {
    const index = next.findIndex((entry) => entry === activeFolder) >= 0
      ? next.indexOf(activeFolder)
      : next.findIndex(isOurs);
    if (index >= 0) next[index] = folderName;
    else next.push(folderName);
    changed = true;
  }
  // A rotation can leave the previous folder listed alongside the new one.
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index] !== folderName && isOurs(next[index])) {
      next.splice(index, 1);
      changed = true;
    }
  }
  if (!changed) {
    log(`Registry      : "${folderName}" already enabled`);
    return next;
  }
  if (dryRun) {
    log(`[dry-run] would set ${registryPath} → ${JSON.stringify(next)}`);
    return next;
  }
  adb.writeFile(registryPath, `${JSON.stringify(next, null, 2)}\n`);
  log(`Registry      : ${registryPath} → ${JSON.stringify(next)}`);
  return next;
}

/** Drop one folder name from `community-plugins.json`, ignoring a missing entry. */
function removeRegistryEntry(adb, registryPath, entry, { dryRun, log }) {
  const text = adb.readFile(registryPath);
  if (text === null) return false;
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return false;
  }
  if (!Array.isArray(list) || !list.includes(entry)) return false;
  const next = list.filter((candidate) => candidate !== entry);
  if (dryRun) {
    log(`[dry-run] would drop "${entry}" from ${registryPath}`);
    return true;
  }
  adb.writeFile(registryPath, `${JSON.stringify(next, null, 2)}\n`);
  log(`Registry      : dropped "${entry}" from ${registryPath}`);
  return true;
}

/** Stop and restart Obsidian so the freshly installed bundle is the one that runs. */
async function restartObsidian(adb, config, { log, warn }) {
  const { packageName, activity } = config.android;
  if (!adb.isPackageInstalled(packageName)) {
    warn(`package ${packageName} is not installed on the device; skipping restart.`);
    return false;
  }
  log(`Restarting    : ${packageName}`);
  adb.forceStop(packageName);
  // `am force-stop` returns before the process is gone; give the loader a moment
  // so the restarted app cannot race the shutdown and reuse the cached bundle.
  await sleep(1500);
  if (activity) adb.startActivity(activity);
  else adb.startLauncher(packageName);
  log("Restarted     : unlock the device to let Obsidian finish loading the new bundle");
  return true;
}

export async function deployToAndroid(config, { adb, log, warn, installDirName, sourceFor }) {
  const { pluginFiles, dryRun } = config;
  const { packageName } = config.android;
  const registryPath = config.android.registryPath;
  const installDir = `${config.vaultRoot}/.obsidian/plugins/${installDirName}`;
  const sourceOf = sourceFor ?? ((name) => join(config.root, name));

  log(`Device        : ${adb.serial}`);
  log(`Vault         : ${config.vaultRoot} (vault name "${config.vaultName}")`);
  log(`Plugin dir    : ${installDir}`);

  if (!adb.isDirectory(config.vaultRoot)) {
    throw new DeployError(
      `device vault directory does not exist: ${config.vaultRoot}\n` +
        "Check MINERAL_DEPLOY_ANDROID_VAULT (a bare name resolves under /sdcard/Documents).",
    );
  }
  if (!adb.isDirectory(installDir)) {
    if (dryRun) {
      log(`[dry-run] would create ${installDir}`);
    } else {
      adb.shellChecked(`mkdir -p '${installDir}'`);
    }
  }

  const results = [];
  for (const name of pluginFiles) {
    const source = sourceOf(name);
    if (!existsSync(source)) {
      if (name === "styles.css") {
        log(`Skipped       : ${name} (not present in the repository)`);
        continue;
      }
      throw new DeployError(`build artifact is missing: ${source}\nRun the build (or drop --skip-build).`);
    }
    const bytes = statSync(source).size;
    const localHash = sha256Hex(source);
    const remote = `${installDir}/${name}`;
    const remoteHash = adb.remoteHash(remote);
    if (remoteHash === localHash && !config.force) {
      log(`Unchanged     : ${name} (device already has this build, SHA-256 ${localHash})`);
      results.push({ name, destination: remote, bytes, hash: localHash.toUpperCase(), skipped: true });
      continue;
    }
    if (dryRun) {
      log(`[dry-run] would push ${name} (${formatBytes(bytes)}) → ${remote}`);
      continue;
    }
    const temporary = `${remote}.tmp-${Date.now()}`;
    adb.push(source, temporary);
    const pushedHash = adb.remoteHash(temporary);
    if (pushedHash !== null && pushedHash !== localHash) {
      adb.remove(temporary);
      throw new DeployError(
        `push verification failed for ${name}: local ${localHash}, device ${pushedHash}. ` +
          "The transfer was truncated; nothing was installed.",
      );
    }
    // `mv` inside the same filesystem is atomic: readers see either the old bundle
    // or the complete new one, never a partially written file.
    adb.shellChecked(`mv -f '${temporary}' '${remote}'`);
    const installed = adb.remoteHash(remote);
    if (installed !== null && installed !== localHash) {
      throw new DeployError(`post-install hash mismatch for ${remote}: expected ${localHash}, got ${installed}.`);
    }
    const remoteSize = adb.remoteSize(remote);
    results.push({ name, destination: remote, bytes, hash: localHash.toUpperCase(), remoteBytes: remoteSize });
    log(
      `Installed     : ${name}  ${formatBytes(bytes)}  SHA-256 ${localHash.toUpperCase()}` +
        (remoteSize !== null ? `  (device reports ${formatBytes(remoteSize)})` : ""),
    );
  }

  // --- registry -------------------------------------------------------------------------
  const registry = activeFolderFromRegistry(adb, registryPath, config.pluginId);
  const { list, folder: previousFolder } = registry;
  if (list === null && !dryRun && !adb.exists(registryPath)) {
    warn(`${registryPath} not found; enable the plugin manually in Obsidian settings.`);
  } else if (list !== null) {
    updateRegistry(adb, registryPath, list, installDirName, config.pluginId, {
      dryRun,
      log,
      activeFolder: previousFolder,
    });
  }

  // Report (and optionally remove) other enabled folders that declare the same
  // plugin id. Two of them load at once, which duplicates commands and handlers.
  const prune = config.prune;
  const duplicates = findDuplicateFolders(adb, registryPath, config.pluginId, installDirName).filter(
    // The immediately-previous rotated folder is cleaned up below, not warned about.
    (entry) => !(entry.startsWith(`${config.pluginId}-deploy-`) && previousFolder === entry),
  );
  if (duplicates.length > 0) {
    const dirs = duplicates.map((entry) => `${config.vaultRoot}/.obsidian/plugins/${entry}`);
    if (prune) {
      for (const [index, entry] of duplicates.entries()) {
        if (dryRun) {
          log(`[dry-run] would remove duplicate plugin folder ${dirs[index]}`);
          continue;
        }
        migratePluginData(adb, dirs[index], installDir, log, warn);
        adb.remove(dirs[index]);
        removeRegistryEntry(adb, registryPath, entry, { dryRun, log });
        log(`Pruned        : removed duplicate plugin folder ${dirs[index]}`);
      }
    } else {
      warn(
        `another enabled folder declares the same plugin id and will load as well:\n` +
          duplicates.map((entry) => `    ${entry}`).join("\n") +
          "\n    Duplicated commands and event handlers are the usual symptom. Re-run with --prune to remove them.",
      );
    }
  }

  // Retire the folder that was active before this deploy, once the new bundle is
  // fully in place. This is decided by whether the folder actually exists, not by
  // its name: a folder renamed by hand still holds the stale copy of the plugin,
  // and leaving it behind is exactly the duplicate-load trap.
  const retired = [];
  if (previousFolder && previousFolder !== installDirName && registry.claimed.includes(previousFolder)) {
    retired.push(previousFolder);
  }

  // Rotation leaves a trail of `<pluginId>-deploy-*` folders whenever a deploy is
  // interrupted or the registry is changed by hand. Only folders this script named
  // are ever considered, so a hand-named folder like `mineral-sync13` is handled by
  // the duplicate check above instead of being deleted unannounced.
  const pluginsDir = `${config.vaultRoot}/.obsidian/plugins`;
  const stale = selectStaleDeployFolders(
    listFolderNames(adb, pluginsDir),
    config.pluginId,
    installDirName,
    retired,
    (name) => adb.isDirectory(`${pluginsDir}/${name}`),
  );

  if (stale.length > 0) {
    if (config.rotate) {
      // Rotating: every stale deploy folder is a superseded copy of this plugin,
      // so retire them in the same breath as the folder being replaced.
      retired.push(...stale);
    } else {
      warn(
        `superseded deploy folders from earlier rotations are still on disk:\n` +
          stale.map((name) => `    ${config.vaultRoot}/.obsidian/plugins/${name}`).join("\n") +
          "\n    They are not enabled, so nothing loads twice, but they hold a stale copy and disk space." +
          " Re-run with --rotate (or --prune) to remove them.",
      );
    }
  }

  // Move the plugin's settings forward before deleting anything: `data.json` is
  // the R2 credentials and every user preference, and it only ever lives in the
  // folder that was running.
  for (const name of retired) {
    const fromDir = `${config.vaultRoot}/.obsidian/plugins/${name}`;
    if (dryRun) {
      log(`[dry-run] would migrate data.json out of and remove ${fromDir}`);
      continue;
    }
    migratePluginData(adb, fromDir, installDir, log, warn);
    adb.remove(fromDir);
    log(`Cleaned       : removed superseded bundle ${fromDir}`);
  }

  // A retired entry can also be a registry row whose folder is already gone.
  if (previousFolder && previousFolder !== installDirName && !adb.isDirectory(`${config.vaultRoot}/.obsidian/plugins/${previousFolder}`)) {
    removeRegistryEntry(adb, registryPath, previousFolder, { dryRun, log });
  }

  if (config.restart && !dryRun) {
    await restartObsidian(adb, config, { log, warn });
  } else if (!dryRun) {
    log("Next step     : reload Obsidian (or restart it) to load the new bundle.");
  }

  if (!dryRun && packageName && !adb.isPackageInstalled(packageName)) {
    warn(`package ${packageName} was not found on the device; is Obsidian installed?`);
  }

  return { target: "android", serial: adb.serial, vault: config.vaultRoot, pluginDir: installDir, files: results };
}

/**
 * Carry the plugin's `data.json` (settings, R2 credentials) across a rotation.
 * Never overwrites a data file the new directory already has.
 */
function migratePluginData(adb, fromDir, toDir, log, warn) {
  const source = `${fromDir}/data.json`;
  const destination = `${toDir}/data.json`;
  if (!adb.exists(source)) return false;
  if (adb.exists(destination)) {
    log(`Data          : ${destination} already exists; kept the newer file.`);
    return false;
  }
  const copy = adb.shell(`cp -p '${source}' '${destination}'`);
  if (!copy.ok) {
    warn(`could not migrate ${source} → ${destination}: ${copy.stderr.trim()}`);
    return false;
  }
  log(`Data          : migrated data.json from the previous plugin folder.`);
  return true;
}

/** Read the built manifest so the caller can log it and rotate on version. */
export function readLocalManifest(root) {
  const path = join(root, "manifest.json");
  if (!existsSync(path)) return null;
  try {
    return readJsonFile(path);
  } catch {
    return null;
  }
}

export const __internal = { activeFolderFromRegistry, updateRegistry, migratePluginData };
