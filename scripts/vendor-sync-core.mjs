#!/usr/bin/env node
/**
 * vendor-sync-core.mjs — rebuild and consume a vendored copy of @mineral/sync-core.
 *
 * Lives in the consumer repository. The source repository is referenced only via `--from`,
 * so this script (and the consumer repo that contains it) is project-name-agnostic: there
 * is no path or string baked in here that ties the consumer to a specific source name.
 *
 * Usage:
 *   node scripts/vendor-sync-core.mjs --from <path-to-source-repo>
 *   npm run sync-core:link                                     (reads .env)
 *   SYNC_CORE_SOURCE=<path> npm run sync-core:link              (env override)
 *   SYNC_CORE_FROM=<path>  npm run sync-core:link              (legacy env)
 *
 * Steps performed in order:
 *   1. Resolve the source: the directory passed via --from must contain a
 *      `packages/sync-core/package.json`. Bail out cleanly if it does not.
 *   2. Read the version from `packages/sync-core/package.json`. The tarball is named
 *      `mineral-sync-core-<version>.tgz` on both ends.
 *   3. Run `npm run build -w @mineral/sync-core` to compile the dist.
 *   4. Run `npm pack -w @mineral/sync-core --pack-destination <tmp>` to produce the tarball.
 *   5. Compute SHA-256, npm shasum (SHA-1 hex), and npm integrity (sha512-base64) over the tarball.
 *   6. Copy the tarball into `<consumer>/vendor/`.
 *   7. Update `<consumer>/package.json`'s `dependencies["@mineral/sync-core"]` to the new
 *      `file:vendor/mineral-sync-core-<version>.tgz` path.
 *   8. Run `npm install` inside the consumer so `package-lock.json` re-validates against the
 *      new tarball's integrity.
 *   9. Update the hash table in `<consumer>/vendor/README.md`. Hand-written prose and the
 *      "What this revision carries" / "Rebuilding this artifact" sections are left alone —
 *      only the seven rows of the table are rewritten.
 *  10. Smoke test: `node --input-type=module -e "import('@mineral/sync-core/hot-protocol')..."`
 *      from the consumer dir. Bail if the package cannot resolve.
 *
 * Flags:
 *   --from <path>       Source repo root. Falls back to SYNC_CORE_SOURCE from `.env`,
 *                       then SYNC_CORE_FROM from the shell environment.
 *   --into <path>       Consumer root. Defaults to the current working directory.
 *   --dry-run           Print every action without modifying anything. Exit 0 on full plan.
 *   --skip-install      Skip the consumer's `npm install`. Useful for chained CI jobs.
 *   --skip-smoke        Skip the smoke test at the end.
 *   --keep-tmp          Keep the temp tarball that `npm pack` produces. Diagnostic only.
 *
 * Exit codes:
 *   0  success (or dry-run with a complete plan)
 *   1  argument / path problem (source missing, dep not declared, etc.)
 *   2  build / pack / install / smoke failed
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

/* ------------------------------------------------------------------------------------------
 * Argument parsing
 * ---------------------------------------------------------------------------------------*/

function parseArgs(argv) {
  const out = {
    from: null,
    into: process.cwd(),
    dryRun: false,
    skipInstall: false,
    skipSmoke: false,
    keepTmp: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--from": out.from = argv[++i] ?? null; break;
      case "--into": out.into = resolve(argv[++i] ?? process.cwd()); break;
      case "--dry-run": out.dryRun = true; break;
      case "--skip-install": out.skipInstall = true; break;
      case "--skip-smoke": out.skipSmoke = true; break;
      case "--keep-tmp": out.keepTmp = true; break;
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        die(1, `unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  // Resolution order for the source root: --from CLI > SYNC_CORE_SOURCE (from .env / shell)
  // > SYNC_CORE_FROM (legacy shell-only). We only fall back to the shell env if the script
  // cannot pull a value from `.env`; the `.env` file is the canonical store on disk.
  if (!out.from) out.from = readDotEnv(process.cwd()).SYNC_CORE_SOURCE ?? null;
  if (!out.from) out.from = process.env.SYNC_CORE_FROM ?? null;
  return out;
}

/**
 * Minimal `.env` reader — KEY=VALUE lines, `#` comments, no shell quoting.
 *
 * This deliberately avoids adding `dotenv` as a runtime cost for one script. The grammar
 * the script needs is tiny: a line is a comment, blank, or a key followed by `=` and an
 * optional value. Trailing whitespace is trimmed. Tabs around the `=` are tolerated.
 */
function readDotEnv(dir) {
  const result = {};
  const candidates = [".env", ".env.local"];
  for (const name of candidates) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let rawValue = line.slice(eq + 1).trim();
      // Strip one matching pair of surrounding quotes, if present.
      if (rawValue.length >= 2 &&
          ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
           (rawValue.startsWith("'") && rawValue.endsWith("'")))) {
        rawValue = rawValue.slice(1, -1);
      }
      // Last assignment wins — later env files override earlier ones.
      result[key] = rawValue;
    }
  }
  return result;
}

const USAGE = `\
Usage: node scripts/vendor-sync-core.mjs --from <path-to-source-repo>
       npm run sync-core:link                                (reads .env)

Resolution order for the source root:
  1. --from CLI flag
  2. SYNC_CORE_SOURCE in .env / .env.local (current directory)
  3. SYNC_CORE_FROM in the shell environment

Flags:
  --from <path>     Source repo root (overrides env).
  --into <path>     Consumer repo root. Defaults to the current working directory.
  --dry-run         Print every action without modifying anything.
  --skip-install    Skip the consumer's \`npm install\` (use when chained CI will).
  --skip-smoke      Skip the post-import smoke test.
  --keep-tmp        Keep the temp tarball that \`npm pack\` produces.
  -h / --help       Show this help.
`;

/* ------------------------------------------------------------------------------------------
 * Plumbing: die + run
 * ---------------------------------------------------------------------------------------*/

function die(code, message) {
  process.stderr.write(`vendor-sync-core: ${message}\n`);
  process.exit(code);
}

/** Spawn a process, capture stdout+stderr, return { stdout, stderr }. Throws on non-zero exit. */
async function run(command, args, options = {}) {
  const fullArgs = args ?? [];
  return await new Promise((resolve, reject) => {
    // On Windows the npm CLI ships as `npm.cmd`; without the suffix `spawn` returns ENOENT
    // because the kernel does not consult PATH for bare names. Other commands (`node`, `tar`)
    // resolve as executables directly on both platforms, so this only matters for npm.
    // On Windows, spawning `.cmd` files also requires `shell: true` to avoid EINVAL from
    // the CreateProcess wrapper — the npm wrapper would otherwise be treated as a binary
    // it cannot load. We pass fixed, fully-controlled argv so the shell does not introduce
    // any injection surface.
    const isNpm = command === "npm" || command === "npm.cmd" || command === "npm.bat";
    const resolvedCommand = process.platform === "win32" && isNpm ? "npm.cmd" : command;
    const useShell = process.platform === "win32" && isNpm;
    const child = spawn(resolvedCommand, fullArgs, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      shell: useShell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => reject(new Error(`${command} failed to start: ${error.message}`)));
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(
        `${command} ${fullArgs.join(" ")} exited ${code}\n${stderr.trim().slice(-2000)}`,
      ));
    });
  });
}

/** Step logger: dry-run shows the line, real run executes the callback. */
async function step(label, dryRun, work) {
  process.stdout.write(`→ ${label}\n`);
  if (dryRun) return undefined;
  return await work();
}

/* ------------------------------------------------------------------------------------------
 * Main
 * ---------------------------------------------------------------------------------------*/

const args = parseArgs(process.argv.slice(2));
if (!args.from) die(1, USAGE);
const sourceRoot = resolve(args.from);
if (!existsSync(sourceRoot)) die(1, `source directory not found: ${sourceRoot}`);
const consumerDir = args.into;
if (!existsSync(consumerDir)) die(1, `consumer directory not found: ${consumerDir}`);

const syncCorePkgPath = join(sourceRoot, "packages", "sync-core", "package.json");
if (!existsSync(syncCorePkgPath)) die(1, `sync-core package.json not found at ${syncCorePkgPath}; does --from point at a repo with packages/sync-core/?`);

const syncCorePkg = JSON.parse(await readFile(syncCorePkgPath, "utf8"));
const version = syncCorePkg.version;
if (!version) die(1, "sync-core package.json has no version");
const tarballName = `mineral-sync-core-${version}.tgz`;
const consumerVendor = join(consumerDir, "vendor");
const consumerPkgPath = join(consumerDir, "package.json");
if (!existsSync(consumerPkgPath)) die(1, `consumer package.json not found: ${consumerPkgPath}`);

const consumerPkg = JSON.parse(await readFile(consumerPkgPath, "utf8"));
const oldDep = consumerPkg.dependencies?.["@mineral/sync-core"];
if (!oldDep) die(1, `consumer does not declare @mineral/sync-core as a dependency; add it first`);
const newDep = `file:vendor/${tarballName}`;

/* ---- step 1 + 2: build the source ----------------------------------------------------- */

await step(`build @mineral/sync-core from ${sourceRoot}`, args.dryRun, async () => {
  await run("npm", ["run", "build", "-w", "@mineral/sync-core"], { cwd: sourceRoot });
});

/* ---- step 3: pack into <sourceRoot>/<tarballName> ------------------------------------ */

const stagedTarball = join(sourceRoot, tarballName);
await step(`pack @mineral/sync-core -> ${stagedTarball}`, args.dryRun, async () => {
  await run("npm", ["pack", "--silent", "-w", "@mineral/sync-core", "--pack-destination", sourceRoot], { cwd: sourceRoot });
});

if (args.dryRun) {
  process.stdout.write(`\nPlan for @mineral/sync-core@${version} -> ${consumerVendor}\n`);
  process.stdout.write(`  source:      ${sourceRoot}\n`);
  process.stdout.write(`  consumer:    ${consumerDir}\n`);
  process.stdout.write(`  tarball:     ${tarballName}\n`);
  process.stdout.write(`  dep:         ${oldDep} -> ${newDep}\n`);
  process.stdout.write(`  skip-install: ${args.skipInstall}\n`);
  process.stdout.write(`  skip-smoke:    ${args.skipSmoke}\n`);
  process.stdout.write("\n(dry run: no files were modified)\n");
  process.exit(0);
}

/* ---- step 4: hashes -------------------------------------------------------------------- */

const tarballBytes = await readFile(stagedTarball);
const sha256 = createHash("sha256").update(tarballBytes).digest("hex");
const shasum = createHash("sha1").update(tarballBytes).digest("hex");
const integrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;

/* ---- step 5: copy into the consumer ---------------------------------------------------- */

await step(`copy ${tarballName} into ${consumerVendor}`, async () => {
  await mkdir(consumerVendor, { recursive: true });
  await copyFile(stagedTarball, join(consumerVendor, tarballName));
});

/* ---- step 6: update package.json's file: dependency ------------------------------------ */

const depChanged = oldDep !== newDep;
await step(
  depChanged ? `update package.json dependency ${oldDep} -> ${newDep}` : `package.json dependency already ${newDep}; no change`,
  async () => {
    if (!depChanged) return;
    consumerPkg.dependencies["@mineral/sync-core"] = newDep;
    await writeFile(consumerPkgPath, JSON.stringify(consumerPkg, null, 2) + "\n");
  },
);

/* ---- step 7: npm install in the consumer to refresh the lockfile ---------------------- */

if (!args.skipInstall) {
  await step(`npm install in ${consumerDir}`, async () => {
    await run("npm", ["install"], { cwd: consumerDir });
  });
} else {
  process.stdout.write("→ skip-install set: consumer lockfile untouched; re-run without it before commit\n");
}

/* ---- step 8: refresh vendor/README.md table ------------------------------------------- */

const readmePath = join(consumerVendor, "README.md");
const readme = existsSync(readmePath) ? await readFile(readmePath, "utf8") : "";
const newReadme = updateVendorReadme(readme, {
  version,
  sha256,
  shasum,
  integrity,
  tarballName,
  newDep,
});
const readmeChanged = newReadme !== readme;
await step(
  readmeChanged ? "update vendor/README.md hash table" : "vendor/README.md already up to date",
  async () => {
    if (!readmeChanged) return;
    await writeFile(readmePath, newReadme);
  },
);

/* ---- step 9: smoke test the consumer's resolution ------------------------------------- */

if (!args.skipSmoke) {
  await step("smoke test @mineral/sync-core resolves and exports hotContentHash", async () => {
    await run("node", [
      "--input-type=module",
      "-e",
      "import('@mineral/sync-core/hot-protocol').then((m) => { if (typeof m.hotContentHash !== 'function') throw new Error('hotContentHash missing'); console.log('smoke OK'); }).catch((e) => { console.error(e); process.exit(1); });",
    ], { cwd: consumerDir });
  });
} else {
  process.stdout.write("→ skip-smoke set: consumer resolution not verified\n");
}

/* ---- step 10: cleanup ------------------------------------------------------------------ */

if (!args.keepTmp) {
  await unlink(stagedTarball).catch(() => undefined);
}

/* ---- done ------------------------------------------------------------------------------ */

process.stdout.write(`\nOK @mineral/sync-core@${version} vendored into ${consumerVendor}\n`);
process.stdout.write(`   sha-256:    ${sha256}\n`);
process.stdout.write(`   npm shasum: ${shasum}\n`);
process.stdout.write(`   integrity:  ${integrity}\n`);

/* ------------------------------------------------------------------------------------------
 * README updater
 * ---------------------------------------------------------------------------------------*/

/**
 * Rewrite the seven machine-managed rows in `vendor/README.md`. Hand-written sections
 * ("What this revision carries", "Rebuilding this artifact", "What is vendored, and what
 * is not") are not touched. Rows that do not exist in the existing file are appended so
 * a brand-new README still gets the table populated.
 *
 * Two cosmetic invariants are preserved across edits:
 *   - Trailing whitespace before the closing pipe is kept, so the column width does not
 *     shift on a no-op rewrite.
 *   - The SHA-256 row keeps whatever case the existing row was in (the original repo
 *     shipped the value in uppercase; the next rebuild should not introduce a noisy diff
 *     by lowercasing it).
 */
function updateVendorReadme(text, info) {
  const rawValues = {
    "Version": info.version,
    "Artifact": `vendor/${info.tarballName}`,
    "SHA-256 (tarball)": info.sha256,
    "npm shasum": info.shasum,
    "npm integrity": info.integrity,
    "Consumption": `"@mineral/sync-core": "${info.newDep}"`,
  };
  let result = text;
  for (const [field, computedValue] of Object.entries(rawValues)) {
    const pattern = new RegExp(`(\\|\\s*${escapeRegex(field)}\\s*\\|\\s*)([^\\n|]+?)(\\s*\\|)`);
    const match = pattern.exec(result);
    if (match) {
      const [, prefix, _oldValue, suffix] = match;
      const existing = match[0].slice(prefix.length, match[0].length - suffix.length);
      const preservedValue = preserveStyle(existing, computedValue);
      result = result.replace(pattern, () => `${prefix}\`${preservedValue}\`${suffix}`);
    } else {
      // Row missing — append it just before the next blank line, or end of file.
      const injection = `\n| ${field} | \`${computedValue}\` |`;
      if (/\n\n/.test(result)) {
        result = result.replace(/\n\n/, `${injection}\n\n`);
      } else {
        result = `${result.trimEnd()}${injection}\n`;
      }
    }
  }
  return result;
}

/**
 * Match the casing (and any other accidental formatting) of the existing value so the
 * rewrite is a no-op when the new content equals the old. Today only the SHA-256 row
 * has a non-uniform style, so we only inspect a hex-shaped match; the rest pass through.
 */
function preserveStyle(existing, computed) {
  const hexMatch = existing.match(/\b([0-9A-Fa-f]{40,})\b/);
  if (!hexMatch) return computed;
  const hex = hexMatch[1];
  return /^[A-F0-9]+$/.test(hex) ? computed.toUpperCase() : computed.toLowerCase();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}