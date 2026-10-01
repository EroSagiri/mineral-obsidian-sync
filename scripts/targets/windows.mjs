/**
 * Windows deployment: copy the built plugin bundle into a desktop Vault's
 * `.obsidian/plugins/<id>/` directory, verify byte equality, and make sure
 * Obsidian will actually pick the new bundle up.
 *
 * The vault directory is never guessed; it arrives from
 * `MINERAL_DEPLOY_WINDOWS_VAULT` / `MINERAL_DEPLOY_VAULT` or `--vault`.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import {
  DeployError,
  copyFileWithParents,
  filesEqual,
  formatBytes,
  hashOf,
  readJsonFile,
  run,
  withPluginEnabled,
  writeJsonFile,
} from "../lib/deploy-lib.mjs";

/**
 * Is Obsidian holding the plugin directory? A running desktop Obsidian keeps the
 * old bundle in memory, so a straight file copy silently does nothing until the
 * user reloads — worth reporting, and worth refusing when `KILL_OBSIDIAN=1`.
 */
function findObsidianProcesses(processName) {
  if (process.platform !== "win32") return [];
  const result = run("tasklist", ["/FI", `IMAGENAME eq ${processName}.exe`, "/FO", "CSV", "/NH"]);
  if (!result.ok) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'))
    .map((line) => {
      const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, ""));
      return { name: cells[0], pid: cells[1] };
    })
    .filter((entry) => entry.name && entry.name.toLowerCase().startsWith(processName.toLowerCase()));
}

function stopObsidian(processName) {
  const result = run("taskkill", ["/IM", `${processName}.exe`, "/T"]);
  if (!result.ok && result.code !== 128) {
    throw new DeployError(`could not stop ${processName}.exe (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return result.ok;
}

function launchObsidian() {
  const result = run("cmd", ["/c", "start", "", "obsidian://"]);
  if (!result.ok) {
    // Not fatal: the protocol handler may be unavailable, the vault target is unknown.
    return false;
  }
  return true;
}

export async function deployToWindows(config, { log, warn, sourceFor }) {
  const { vault, pluginDir, pluginFiles, registryPath } = config;
  const sourceOf = sourceFor ?? ((name) => join(config.root, name));

  log(`Vault         : ${vault}`);
  log(`Plugin dir    : ${pluginDir}`);
  if (!existsSync(vault)) {
    throw new DeployError(`vault directory does not exist: ${vault}\nSet MINERAL_DEPLOY_WINDOWS_VAULT to the Obsidian vault root.`);
  }
  if (!existsSync(pluginDir)) {
    if (config.create && !config.dryRun) {
      log(`Creating      : ${pluginDir}`);
      mkdirSync(pluginDir, { recursive: true });
    } else {
      throw new DeployError(
        `plugin directory does not exist: ${pluginDir}\n` +
          "Install the plugin in Obsidian once (Settings → Community plugins), then re-run; " +
          "or pass --create to let this script create the directory.",
      );
    }
  }

  const running = findObsidianProcesses(config.processName);
  if (running.length > 0) {
    if (config.mustExit && !config.dryRun) {
      warn(`Obsidian is running (${running.length} process(es)); stopping it because KILL_OBSIDIAN=1.`);
      stopObsidian(config.processName);
    } else {
      warn(
        `Obsidian is running (${running.length} process(es), pid ${running.map((entry) => entry.pid).join(", ")}). ` +
          "The copied bundle is not loaded until the plugin is reloaded or Obsidian restarts" +
          (config.restart ? "; --restart will handle it." : "."),
      );
    }
  }

  const results = [];
  for (const name of pluginFiles) {
    const source = sourceOf(name);
    const destination = join(pluginDir, name);
    if (!existsSync(source)) {
      // Optional companions (`styles.css`) may legitimately be absent.
      if (name === "styles.css") {
        log(`Skipped       : ${name} (not present in the repository)`);
        continue;
      }
      throw new DeployError(`build artifact is missing: ${source}\nRun the build (or drop --skip-build).`);
    }
    const size = statSync(source).size;
    if (config.dryRun) {
      log(`[dry-run] would copy ${name} (${formatBytes(size)}) → ${destination}`);
      continue;
    }
    copyFileWithParents(source, destination);
    if (!filesEqual(source, destination)) {
      throw new DeployError(`hash verification failed for ${destination}`);
    }
    const hash = hashOf(destination);
    results.push({ name, destination, bytes: size, hash });
    log(`Installed     : ${name}  ${formatBytes(size)}  SHA-256 ${hash}`);
  }

  // Keeping the plugin enabled in every vault it is deployed to avoids the
  // "files are there but Obsidian says disabled" confusion after a first install.
  if (existsSync(registryPath)) {
    let registry;
    try {
      registry = readJsonFile(registryPath);
    } catch (error) {
      warn(`could not parse ${basename(registryPath)} (${error.message}); leaving it untouched.`);
      registry = null;
    }
    if (registry) {
      const { list, changed } = withPluginEnabled(registry, config.pluginId);
      if (changed) {
        if (config.dryRun) {
          log(`[dry-run] would enable "${config.pluginId}" in ${registryPath}`);
        } else {
          writeJsonFile(registryPath, list);
          log(`Enabled       : "${config.pluginId}" added to ${registryPath}`);
        }
      } else {
        log(`Registry      : "${config.pluginId}" already enabled`);
      }
    }
  } else {
    warn(`${registryPath} not found; enable the plugin manually in Obsidian settings.`);
  }

  if (config.restart && !config.dryRun) {
    warn("Restarting Obsidian so the new bundle is loaded.");
    launchObsidian();
  }

  return { target: "windows", vault, pluginDir, files: results };
}
