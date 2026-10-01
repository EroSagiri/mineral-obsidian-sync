/**
 * Plugin bundle build. Both modes go through esbuild with the repository's
 * `__DEV__` compile-time flag, so a deployment can ship either:
 *
 *   production  — minified, development-only modules stubbed out entirely
 *                 (`npm run build`, the default for deployments)
 *   development — inline sourcemap and the development self-test harness kept in
 *                 the bundle, which the Android hot-sync self-test triggers
 *
 * The development bundle is written to `build-diag/main-dev.js` (git-ignored) and
 * only copied onto `main.js` at deployment time, so a debug bundle can never be
 * mistaken for, or accidentally committed as, the shipped artifact.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { run, DeployError } from "./deploy-lib.mjs";

export const BUILD_ARTIFACT = "main.js";
export const DEV_ARTIFACT = "build-diag/main-dev.js";

/** Repository root, derived from this file's location rather than from `cwd`. */
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The esbuild plugin that removes development-only modules from prod bundles. */
function stubDevelopmentModules() {
  return {
    name: "stub-development-modules",
    setup(build) {
      build.onResolve({ filter: /(^|\/)dev\// }, (args) => ({ path: args.path, namespace: "dev-stub" }));
      build.onLoad({ filter: /.*/, namespace: "dev-stub" }, () => ({
        contents: "export const registerDevelopmentSelfTests = undefined;\n",
        loader: "js",
      }));
    },
  };
}

async function runEsbuild(options) {
  const esbuild = await import("esbuild");
  await esbuild.build(options);
}

/** Production bundle — byte-for-byte the artifact `npm run build` produces. */
async function buildProduction(root) {
  const outfile = join(root, BUILD_ARTIFACT);
  await runEsbuild({
    entryPoints: [join(root, "src/main.ts")],
    bundle: true,
    external: ["obsidian"],
    format: "cjs",
    target: "es2022",
    logLevel: "info",
    sourcemap: false,
    minify: true,
    define: { __DEV__: "false" },
    plugins: [stubDevelopmentModules()],
    outfile,
  });
  return outfile;
}

/**
 * Development bundle. `esbuild.config.mjs` hard-codes `outfile: "main.js"`, so a
 * temporary config is written for the duration of the build and restored in a
 * `finally` block — a failed build must not leave a rewritten config behind.
 */
async function buildDevelopment(root, { log }) {
  const configPath = join(root, "esbuild.config.mjs");
  if (!existsSync(configPath)) throw new DeployError(`build config not found: ${configPath}`);

  const original = readFileSync(configPath, "utf8");
  mkdirSync(join(root, "build-diag"), { recursive: true });
  const outfile = join(root, DEV_ARTIFACT);

  const patch = original
    .replace(/sourcemap:\s*production\s*\?\s*false\s*:\s*"inline"/, 'sourcemap: "inline"')
    .replace(/plugins:\s*production\s*\?\s*\[stubDevelopmentModules\]\s*:\s*\[\]/, "plugins: []")
    .replace(/outfile:\s*"main\.js"/, `outfile: ${JSON.stringify(DEV_ARTIFACT)}`)
    .replace(/const production = process\.argv\[2\] === "production";/, "const production = false;");
  if (!patch.includes('outfile: "build-diag/main-dev.js"')) {
    throw new DeployError(
      "could not redirect the development build output in esbuild.config.mjs; " +
        "the build config changed shape — update scripts/lib/build.mjs to match.",
    );
  }

  try {
    writeFileSync(configPath, patch, "utf8");
    log(`Building development bundle → ${DEV_ARTIFACT} (self-test harness included)`);
    const result = run(process.execPath, [configPath, "development"], { cwd: root, stream: true });
    if (!result.ok) throw new DeployError(`development build failed (exit ${result.code}).`);
  } finally {
    writeFileSync(configPath, original, "utf8");
  }
  return outfile;
}

/**
 * Produce the bundle for the requested mode and return its absolute path.
 *
 * @param {object} options
 * @param {string} [options.root]       Repository root. Defaults to this package.
 * @param {boolean} [options.production] `true` → `main.js`, `false` → dev bundle.
 * @param {(message: string) => void} [options.log]
 */
export async function buildBundle({ root = repoRoot, production = true, log = () => {} } = {}) {
  if (production) {
    log(`Building production bundle → ${BUILD_ARTIFACT}`);
    return buildProduction(root);
  }
  return buildDevelopment(root, { log });
}

/**
 * Install a development bundle as `main.js`. Only a debug build ever needs this,
 * because the deployed file name is always `main.js` on every target.
 */
export function promoteToMain(root, devPath) {
  const target = join(root, BUILD_ARTIFACT);
  copyFileSync(devPath, target);
  return target;
}
