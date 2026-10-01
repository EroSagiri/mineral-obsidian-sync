#!/usr/bin/env node
/**
 * Build the plugin bundle.
 *
 *   node scripts/build.mjs               # production bundle → main.js
 *   node scripts/build.mjs production    # same, explicit
 *   node scripts/build.mjs development   # self-test bundle → build-diag/main-dev.js
 *   node scripts/build.mjs dev --promote # build the dev bundle and install it as main.js
 *
 * `deploy.mjs` calls the same library directly, so a deployment and a manual
 * build can never disagree about what the artifact is.
 */

import { existsSync } from "node:fs";

import { BUILD_ARTIFACT, DEV_ARTIFACT, buildBundle, promoteToMain, repoRoot } from "./lib/build.mjs";

const USAGE = `\
Usage: node scripts/build.mjs [production|development] [options]

Options:
  --promote     Copy the development bundle onto ${BUILD_ARTIFACT} (development only).
  -h, --help    Show this help.
`;

function main(argv) {
  let mode = "production";
  let promote = false;
  for (const arg of argv) {
    switch (arg) {
      case "production": case "prod": mode = "production"; break;
      case "development": case "dev": mode = "development"; break;
      case "--promote": promote = true; break;
      case "-h": case "--help": process.stdout.write(USAGE); return 0;
      default:
        process.stderr.write(`build: unknown argument: ${arg}\n\n${USAGE}`);
        return 2;
    }
  }
  if (promote && mode !== "development") {
    process.stderr.write("build: --promote only applies to the development bundle.\n");
    return 2;
  }
  return { mode, promote };
}

const options = main(process.argv.slice(2));
if (typeof options === "number") process.exit(options);

const production = options.mode === "production";
const outfile = await buildBundle({ root: repoRoot, production, log: (line) => process.stdout.write(`${line}\n`) });
if (!existsSync(outfile)) {
  process.stderr.write(`build: expected artifact was not produced: ${outfile}\n`);
  process.exit(1);
}
if (options.promote) {
  const target = promoteToMain(repoRoot, outfile);
  process.stdout.write(`Promoted ${DEV_ARTIFACT} → ${target}\n`);
}
process.stdout.write(`Built ${production ? BUILD_ARTIFACT : DEV_ARTIFACT}\n`);
process.exit(0);
