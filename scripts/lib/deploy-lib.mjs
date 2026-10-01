/**
 * Lowest-level deployment plumbing shared by the Windows and Android targets:
 * hashing, `.env` loading, bundle staging, JSON registry edits, ADB transport.
 *
 * Everything in here is side-effect free until a caller invokes it, and every
 * remote operation is verified by content hash rather than by exit code alone.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/* ------------------------------------------------------------------------------------------
 * Process + filesystem helpers
 * ---------------------------------------------------------------------------------------*/

export class DeployError extends Error {
  constructor(message, { code = 1 } = {}) {
    super(message);
    this.name = "DeployError";
    this.code = code;
  }
}

/**
 * Run a command and capture stdout/stderr as UTF-8. Returns
 * `{ ok, code, stdout, stderr }` — never throws for a non-zero exit, because
 * callers routinely probe with commands that are expected to fail (`test -f`).
 *
 * `stdio: "pipe"` is required to read the output; the Android push path passes
 * `{ stream: true }` to inherit stdio instead so progress is visible.
 */
export function run(command, args, { cwd, encoding = "utf8", timeout, stream = false, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ?? process.env,
    encoding,
    timeout,
    windowsHide: true,
    stdio: stream ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return { ok: false, code: result.status ?? -1, stdout: "", stderr: String(result.error.message ?? result.error) };
  }
  return {
    ok: result.status === 0,
    code: result.status ?? -1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

/** Run a command and throw a `DeployError` carrying its stderr when it fails. */
export function runChecked(command, args, options = {}) {
  const label = options.label ?? `${command} ${args.join(" ")}`;
  const result = run(command, args, options);
  if (!result.ok) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new DeployError(`${label} failed (exit ${result.code})${detail ? `:\n${detail}` : ""}`);
  }
  return result;
}

/** Perceptual/tooling hash of a file or buffer, uppercase hex like `Get-FileHash`. */
export function hashOf(input) {
  const data = Buffer.isBuffer(input) ? input : readFileSync(input);
  return createHash("sha256").update(data).digest("hex").toUpperCase();
}

export function sha256Hex(input) {
  const data = Buffer.isBuffer(input) ? input : readFileSync(input);
  return createHash("sha256").update(data).digest("hex");
}

export function exists(path) {
  return existsSync(path);
}

export function filesEqual(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  if (statSync(a).size !== statSync(b).size) return false;
  return hashOf(a) === hashOf(b);
}

/** `fs.cpSync` for one file, creating the parent directory chain first. */
export function copyFileWithParents(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

export function readJsonFile(path) {
  return JSON.parse(stripBom(readFileSync(path, "utf8")));
}

/** Write JSON the way Obsidian does: two-space indent, trailing newline, UTF-8. */
export function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** `mineral-obsidian-sync-deploy-0.4.17-20261001-195100` */
export function rotationFolderName(pluginId, version, now = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safeVersion = String(version || "0").replace(/[^\w.+-]/g, "_");
  return `${pluginId}-deploy-${safeVersion}-${stamp}`;
}

/* ------------------------------------------------------------------------------------------
 * Bundle staging — one place decides what "the bundle we ship" means
 * ---------------------------------------------------------------------------------------*/

/**
 * The Android path has a documented trap: pushing a new `main.js` into an
 * existing plugin directory does not change the code Obsidian runs, because the
 * plugin is keyed by folder path. An optional second copy with a content-hashed
 * filename makes the on-device artifact identifiable (`--suffix hash`).
 */
export function stageBundle({ source, stagingDir, suffix = "none", now = new Date() }) {
  const bytes = readFileSync(source);
  mkdirSync(stagingDir, { recursive: true });
  const hash = createHash("sha256").update(bytes).digest("hex");
  let name = "main.js";
  if (suffix === "hash") name = `main-${hash.slice(0, 12)}.js`;
  else if (suffix === "timestamp") {
    const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
    name = `main-${stamp}.js`;
  }
  const staged = join(stagingDir, name);
  writeFileSync(staged, bytes);
  return { path: staged, name, bytes: bytes.byteLength, hash: hash.toUpperCase() };
}

/* ------------------------------------------------------------------------------------------
 * ADB
 * ---------------------------------------------------------------------------------------*/

export function createAdb({ executable = "adb", serial = null, timeoutMs } = {}) {
  const base = serial ? ["-s", serial] : [];

  function raw(args, options = {}) {
    return run(executable, [...base, ...args], { timeout: timeoutMs, ...options });
  }

  function checked(args, options = {}) {
    return runChecked(executable, [...base, ...args], { timeout: timeoutMs, ...options });
  }

  return {
    executable,
    serial,
    raw,
    checked,
    /** One physical device must be connected and authorized. */
    version() {
      const result = raw(["version"]);
      if (!result.ok) {
        throw new DeployError(
          `adb not usable (${executable}). Install Android platform-tools or set MINERAL_DEPLOY_ADB to its full path.\n${result.stderr.trim()}`,
        );
      }
      return result.stdout.split(/\r?\n/)[0]?.trim() ?? "";
    },
    devices() {
      const output = raw(["devices"]).stdout;
      return output
        .split(/\r?\n/)
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => {
          const [id, state] = line.split(/\s+/);
          return { id, state };
        })
        .filter((entry) => entry.id);
    },
    /** Resolve the single authorized device, or require an explicit selection. */
    resolveSerial() {
      if (serial) {
        const state = this.devices().find((device) => device.id === serial);
        if (!state) {
          throw new DeployError(`adb device "${serial}" is not connected.`);
        }
        if (state.state !== "device") {
          throw new DeployError(`adb device "${serial}" is in state "${state.state}", not "device".`);
        }
        return serial;
      }
      const authorized = this.devices().filter((device) => device.state === "device");
      const usable = authorized.filter((device) => !device.id.startsWith("emulator-") || authorized.length === 1);
      if (usable.length !== 1) {
        const seen = this.devices().map((device) => `${device.id} (${device.state})`).join(", ") || "none";
        throw new DeployError(
          `expected exactly one authorized ADB device, found ${usable.length}; connected: ${seen}. ` +
            "Pass --serial <device> or set MINERAL_DEPLOY_ANDROID_SERIAL.",
        );
      }
      return usable[0].id;
    },
    shell(command, options = {}) {
      return this.raw(["shell", command], options);
    },
    shellChecked(command, options = {}) {
      return this.checked(["shell", command]);
    },
    /** Push a local file to a device path, creating the parent directory first. */
    push(localPath, remotePath) {
      this.shellChecked(`mkdir -p '${dirname(remotePath)}'`);
      this.checked(["push", localPath, remotePath], { stream: true });
    },
    /** `sha256sum` when the device has it, otherwise `md5sum`, otherwise `null`. */
    remoteHash(remotePath) {
      for (const tool of ["sha256sum", "md5sum"]) {
        const result = this.shell(`${tool} '${remotePath}' 2>/dev/null`);
        if (result.ok && result.stdout.trim() !== "") return result.stdout.trim().split(/\s+/)[0].toLowerCase();
      }
      return null;
    },
    exists(remotePath) {
      return this.shell(`test -e '${remotePath}'`).ok;
    },
    isDirectory(remotePath) {
      return this.shell(`test -d '${remotePath}'`).ok;
    },
    readFile(remotePath) {
      const result = this.shell(`cat '${remotePath}' 2>/dev/null`);
      return result.ok ? stripBom(result.stdout) : null;
    },
    writeFile(remotePath, contents) {
      // Base64 keeps the payload free of characters the device shell would eat.
      const encoded = Buffer.from(contents, "utf8").toString("base64");
      this.shellChecked(`mkdir -p '${dirname(remotePath)}'`);
      this.shellChecked(`printf '%s' '${encoded}' | base64 -d > '${remotePath}'`);
    },
    remove(remotePath) {
      return this.shell(`rm -rf '${remotePath}'`);
    },
    remoteSize(remotePath) {
      const result = this.shell(`wc -c < '${remotePath}' 2>/dev/null`);
      const parsed = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(parsed) ? parsed : null;
    },
    forceStop(packageName) {
      this.shellChecked(`am force-stop ${packageName}`);
    },
    /** Launch a specific activity, e.g. `md.obsidian/.MainActivity`. */
    startActivity(component) {
      this.shellChecked(`am start -n ${component}`);
    },
    /** Launch the package's default launcher intent without naming an activity. */
    startLauncher(packageName) {
      this.shellChecked(`monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`);
    },
    isPackageInstalled(packageName) {
      return this.shell(`pm list packages ${packageName} | grep -q 'package:${packageName}'`).ok;
    },
  };
}

/* ------------------------------------------------------------------------------------------
 * Obsidian plugin registry (`community-plugins.json`)
 * ---------------------------------------------------------------------------------------*/

/**
 * Ensure `pluginId` is present in an enabled-plugins list. Returns a new array and
 * whether anything changed, so callers can decide to write.
 */
export function withPluginEnabled(list, pluginId) {
  if (!Array.isArray(list)) return { list: [pluginId], changed: true };
  if (list.includes(pluginId)) return { list, changed: false };
  return { list: [...list, pluginId], changed: true };
}

/* ------------------------------------------------------------------------------------------
 * Tiny reporting helpers (shared by both targets)
 * ---------------------------------------------------------------------------------------*/

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Resolve the local file to copy for one deployed artifact.
 *
 * `main.js` may come from anywhere — the production bundle at the repository
 * root, the development bundle in `build-diag/`, or a staged copy — while every
 * other artifact (`manifest.json`, `styles.css`) always comes from the root.
 * Keeping this in one place is what stops a development deploy from silently
 * shipping the production bundle.
 */
export function createSourceResolver(root, bundleSource) {
  return function sourceFor(name) {
    if (name === "main.js" && bundleSource) return bundleSource;
    return join(root, name);
  };
}
