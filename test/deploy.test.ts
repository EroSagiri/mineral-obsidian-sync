/**
 * Regression tests for the deployment plumbing in `scripts/lib`.
 *
 * These cover the parts that are pure or filesystem-local: path resolution, the
 * `.env` reader, rotation naming, registry editing. Nothing here touches a real
 * vault, a real device or the network — those paths are exercised by the
 * deployment scripts themselves.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { __internal, selectStaleDeployFolders } from "../scripts/targets/android.mjs";

const { activeFolderFromRegistry } = __internal;

import {
  expandPath,
  parseAndroidVault,
  readDotEnv,
  resolveDeployConfig as resolveConfig,
  toBool,
  toInt,
  toList,
} from "../scripts/lib/deploy-config.mjs";
import type { AndroidDeployConfig, WindowsDeployConfig } from "../scripts/lib/deploy-config.mjs";
import {
  createSourceResolver,
  rotationFolderName,
  sha256Hex,
  stageBundle,
  withPluginEnabled,
} from "../scripts/lib/deploy-lib.mjs";

/**
 * The implementation is plain JavaScript, so the target-specific fields only
 * exist on the matching config shape. These two wrappers keep the narrowing in
 * one place instead of scattering casts through the assertions.
 */
function windowsConfig(root: string, overrides: Record<string, unknown> = {}): WindowsDeployConfig {
  return resolveConfig({ root, target: "windows", overrides }) as WindowsDeployConfig;
}

function androidConfig(root: string, overrides: Record<string, unknown> = {}): AndroidDeployConfig {
  return resolveConfig({ root, target: "android", overrides }) as AndroidDeployConfig;
}

const temporaryDirectories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "mineral-deploy-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * A fake device: just enough of the ADB surface for the folder-detection logic to
 * run against a described vault instead of a real phone.
 */
function fakeDevice(files: Record<string, string>, options: { directories?: Record<string, true> } = {}) {
  const directories = options.directories ?? {};
  return {
    readFile: (path: string) => files[path] ?? null,
    isDirectory: (path: string) => directories[path] === true,
    writes: [] as { path: string; contents: string }[],
    writeFile(path: string, contents: string) {
      this.writes.push({ path, contents });
      files[path] = contents;
    },
  };
}

const PLUGIN_ID = "mineral-obsidian-sync";
const REGISTRY = "/sdcard/Documents/mineral/.obsidian/community-plugins.json";
const PLUGINS = "/sdcard/Documents/mineral/.obsidian/plugins";

function manifestFor(id: string): string {
  return JSON.stringify({ id, name: "Mineral Obsidian Sync", version: "0.4.17" });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseAndroidVault", () => {
  it("resolves a bare vault name under /sdcard/Documents", () => {
    expect(parseAndroidVault("mineral")).toEqual({
      vaultName: "mineral",
      vaultRoot: "/sdcard/Documents/mineral",
      androidRoot: "sdcard",
    });
  });

  it("accepts an absolute /storage path and keeps its root", () => {
    expect(parseAndroidVault("/storage/emulated/0/Documents/mineral")).toEqual({
      vaultName: "mineral",
      vaultRoot: "/storage/emulated/0/Documents/mineral",
      androidRoot: "storage",
    });
  });

  it("accepts a nested vault directory", () => {
    expect(parseAndroidVault("obsidian/mineral").vaultRoot).toBe("/sdcard/Documents/obsidian/mineral");
  });

  it("normalises Windows separators and trailing slashes", () => {
    expect(parseAndroidVault("Documents\\mineral\\").vaultRoot).toBe("/sdcard/Documents/mineral");
  });
});

describe("expandPath", () => {
  it("resolves relative paths against the repository root", () => {
    expect(expandPath("vault", "C:\\repo")).toBe("C:\\repo\\vault");
  });

  it("expands environment variables in a path", () => {
    process.env.MINERAL_DEPLOY_TEST_ROOT = "C:\\expanded";
    try {
      expect(expandPath("%MINERAL_DEPLOY_TEST_ROOT%\\vault", "C:\\repo")).toBe("C:\\expanded\\vault");
    } finally {
      delete process.env.MINERAL_DEPLOY_TEST_ROOT;
    }
  });
});

describe("value coercion", () => {
  it("reads booleans from the spellings people actually write", () => {
    expect(toBool("true", false)).toBe(true);
    expect(toBool("YES", false)).toBe(true);
    expect(toBool("0", true)).toBe(false);
    expect(toBool(undefined, true)).toBe(true);
    expect(toBool("nonsense", true)).toBe(true);
  });

  it("splits artifact lists on commas and whitespace", () => {
    expect(toList("main.js, manifest.json styles.css")).toEqual(["main.js", "manifest.json", "styles.css"]);
    expect(toList(undefined)).toEqual([]);
  });

  it("falls back for unparsable numbers", () => {
    expect(toInt("5000", 1)).toBe(5000);
    expect(toInt("abc", 7)).toBe(7);
  });
});

describe("readDotEnv", () => {
  it("reads KEY=VALUE, ignores comments and strips one quote pair", () => {
    const directory = temporaryDirectory();
    writeFileSync(
      join(directory, ".env"),
      ['# comment', "MINERAL_DEPLOY_ANDROID_VAULT=mineral", 'MINERAL_DEPLOY_WINDOWS_VAULT="C:\\with space\\vault"', ""].join(
        "\n",
      ),
      "utf8",
    );
    const values = readDotEnv(directory);
    expect(values.MINERAL_DEPLOY_ANDROID_VAULT).toBe("mineral");
    expect(values.MINERAL_DEPLOY_WINDOWS_VAULT).toBe("C:\\with space\\vault");
  });
});

describe("resolveDeployConfig", () => {
  it("derives the Windows plugin directory from the configured vault root", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, ".env"), "MINERAL_DEPLOY_WINDOWS_VAULT=C:\\vaults\\work\n", "utf8");
    const config = windowsConfig(directory);
    expect(config.pluginDir).toBe("C:\\vaults\\work\\.obsidian\\plugins\\mineral-obsidian-sync");
    expect(config.registryPath).toBe("C:\\vaults\\work\\.obsidian\\community-plugins.json");
  });

  it("fails with an actionable message when no vault is configured", () => {
    const directory = temporaryDirectory();
    expect(() => windowsConfig(directory)).toThrow(/MINERAL_DEPLOY_WINDOWS_VAULT/);
    expect(() => androidConfig(directory)).toThrow(/MINERAL_DEPLOY_ANDROID_VAULT/);
  });

  it("honours the shared MINERAL_DEPLOY_VAULT fallback", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, ".env"), "MINERAL_DEPLOY_VAULT=shared-vault\n", "utf8");
    expect(androidConfig(directory).vaultRoot).toBe("/sdcard/Documents/shared-vault");
  });

  it("lets a CLI override win over .env", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, ".env"), "MINERAL_DEPLOY_ANDROID_VAULT=from-file\n", "utf8");
    const config = androidConfig(directory, { vault: "from-flag" });
    expect(config.vaultRoot).toBe("/sdcard/Documents/from-flag");
  });

  it("rotates the Android plugin folder by default when a restart is requested", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, ".env"), "MINERAL_DEPLOY_ANDROID_VAULT=mineral\n", "utf8");
    expect(androidConfig(directory).rotate).toBe(false);
    expect(androidConfig(directory, { restart: true }).rotate).toBe(true);
  });

  it("lets an explicit rotate setting override the restart default in either direction", () => {
    const directory = temporaryDirectory();
    writeFileSync(
      join(directory, ".env"),
      "MINERAL_DEPLOY_ANDROID_VAULT=mineral\nMINERAL_DEPLOY_ROTATE_PLUGIN_DIR=false\n",
      "utf8",
    );
    expect(androidConfig(directory, { restart: true }).rotate).toBe(false);

    const other = temporaryDirectory();
    writeFileSync(
      join(other, ".env"),
      "MINERAL_DEPLOY_ANDROID_VAULT=mineral\nMINERAL_DEPLOY_ROTATE_PLUGIN_DIR=true\n",
      "utf8",
    );
    expect(androidConfig(other).rotate).toBe(true);
  });

  it("refuses an unknown build mode instead of silently building production", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, ".env"), "MINERAL_DEPLOY_ANDROID_VAULT=mineral\n", "utf8");
    expect(() => androidConfig(directory, { build: "fast" })).toThrow(/unknown build mode/);
  });
});

describe("activeFolderFromRegistry", () => {
  it("recognises the plain plugin folder as active, not just rotated ones", () => {
    // Regression: the canonical entry used to be skipped instead of recorded, so
    // a registry pointing at "<pluginId>" looked like it belonged to nobody and
    // the previous install was never cleaned up after a rotation.
    const device = fakeDevice(
      {
        [REGISTRY]: JSON.stringify(["share-note", PLUGIN_ID]),
        [`${PLUGINS}/${PLUGIN_ID}/manifest.json`]: manifestFor(PLUGIN_ID),
      },
      { directories: { [`${PLUGINS}/${PLUGIN_ID}`]: true } },
    );
    const result = activeFolderFromRegistry(device as never, REGISTRY, PLUGIN_ID);
    expect(result.folder).toBe(PLUGIN_ID);
    expect(result.claimed).toEqual([PLUGIN_ID]);
  });

  it("prefers the canonical folder over a rotated one", () => {
    const rotated = `${PLUGIN_ID}-deploy-0.4.17-20261001-223005`;
    const device = fakeDevice(
      {
        [REGISTRY]: JSON.stringify([rotated, PLUGIN_ID]),
        [`${PLUGINS}/${rotated}/manifest.json`]: manifestFor(PLUGIN_ID),
        [`${PLUGINS}/${PLUGIN_ID}/manifest.json`]: manifestFor(PLUGIN_ID),
      },
      { directories: { [`${PLUGINS}/${rotated}`]: true, [`${PLUGINS}/${PLUGIN_ID}`]: true } },
    );
    const result = activeFolderFromRegistry(device as never, REGISTRY, PLUGIN_ID);
    expect(result.folder).toBe(PLUGIN_ID);
    expect(result.claimed).toEqual([rotated, PLUGIN_ID]);
  });

  it("treats an entry whose folder is gone from the device as not active", () => {
    const rotated = `${PLUGIN_ID}-deploy-0.4.17-20261001-223005`;
    const device = fakeDevice({ [REGISTRY]: JSON.stringify([rotated]) }, { directories: {} });
    const result = activeFolderFromRegistry(device as never, REGISTRY, PLUGIN_ID);
    // Nothing is claimed: with no directory and no readable manifest there is no
    // evidence the entry is ours, so it must not become a cleanup target.
    expect(result.folder).toBeNull();
    expect(result.claimed).toEqual([]);
    expect(result.list).toEqual([rotated]);
  });

  it("still records the canonical entry when its manifest is unreadable", () => {
    // The plain folder is this plugin by definition — a missing or corrupt
    // manifest must not hide the previous install from the cleanup step.
    const device = fakeDevice({ [REGISTRY]: JSON.stringify([PLUGIN_ID]) }, { directories: {} });
    const result = activeFolderFromRegistry(device as never, REGISTRY, PLUGIN_ID);
    expect(result.claimed).toEqual([PLUGIN_ID]);
    expect(result.folder).toBeNull();
  });

  it("matches a folder renamed to something else by its manifest id", () => {
    const device = fakeDevice(
      {
        [REGISTRY]: JSON.stringify(["mineral-sync13"]),
        [`${PLUGINS}/mineral-sync13/manifest.json`]: manifestFor(PLUGIN_ID),
      },
      { directories: { [`${PLUGINS}/mineral-sync13`]: true } },
    );
    const result = activeFolderFromRegistry(device as never, REGISTRY, PLUGIN_ID);
    expect(result.folder).toBe("mineral-sync13");
    expect(result.claimed).toEqual(["mineral-sync13"]);
  });

  it("reports an unreadable or malformed registry as unknown rather than empty", () => {
    const missing = activeFolderFromRegistry(fakeDevice({}) as never, REGISTRY, PLUGIN_ID);
    expect(missing.list).toBeNull();

    const malformed = activeFolderFromRegistry(
      fakeDevice({ [REGISTRY]: "{ not json" }) as never,
      REGISTRY,
      PLUGIN_ID,
    );
    expect(malformed.list).toBeNull();
    expect(malformed.claimed).toEqual([]);
  });
});

describe("selectStaleDeployFolders", () => {
  const alwaysADirectory = () => true;
  const other = "mineral-obsidian-sync-deploy-0.4.17-20261001-223005";

  it("selects only our own rotation folders, never a hand-named one", () => {
    const entries = ["mineral-sync13", PLUGIN_ID, other, `${PLUGIN_ID}-deploy-x`];
    const selected = selectStaleDeployFolders(entries, PLUGIN_ID, PLUGIN_ID, [], alwaysADirectory);
    // `mineral-sync13` and the canonical folder are deliberately untouched: the
    // duplicate path and `--prune` own those, because they may predate this script.
    expect(selected).toEqual([other, `${PLUGIN_ID}-deploy-x`]);
  });

  it("never selects the folder being installed into or one already retired", () => {
    const selected = selectStaleDeployFolders(
      [other, `${PLUGIN_ID}-deploy-keep`],
      PLUGIN_ID,
      `${PLUGIN_ID}-deploy-keep`,
      [other],
      alwaysADirectory,
    );
    expect(selected).toEqual([]);
  });

  it("ignores names that are not real directories", () => {
    const selected = selectStaleDeployFolders([other], PLUGIN_ID, PLUGIN_ID, [], () => false);
    expect(selected).toEqual([]);
  });
});

describe("rotationFolderName", () => {
  it("encodes the plugin id, version and a sortable timestamp", () => {
    const name = rotationFolderName("mineral-obsidian-sync", "0.4.17", new Date(2026, 9, 1, 22, 30, 5));
    expect(name).toBe("mineral-obsidian-sync-deploy-0.4.17-20261001-223005");
  });

  it("sanitises a version that contains path separators", () => {
    const name = rotationFolderName("plugin", "1.0/../evil", new Date(2026, 0, 2, 3, 4, 5));
    expect(name).toBe("plugin-deploy-1.0_.._evil-20260102-030405");
  });
});

describe("stageBundle", () => {
  it("writes the bundle bytes unchanged and reports their hash", () => {
    const directory = temporaryDirectory();
    const source = join(directory, "main.js");
    writeFileSync(source, "console.log('bundle');\n", "utf8");
    const staged = stageBundle({ source, stagingDir: join(directory, "staged") });
    expect(staged.name).toBe("main.js");
    expect(readFileSync(staged.path, "utf8")).toBe("console.log('bundle');\n");
    expect(staged.hash).toBe(sha256Hex(source).toUpperCase());
  });

  it("names a staged copy after its content when asked", () => {
    const directory = temporaryDirectory();
    const source = join(directory, "main.js");
    writeFileSync(source, "x", "utf8");
    const staged = stageBundle({ source, stagingDir: join(directory, "staged"), suffix: "hash" });
    expect(staged.name).toMatch(/^main-[0-9a-f]{12}\.js$/);
    expect(staged.name).toContain(sha256Hex(source).slice(0, 12));
  });
});

describe("createSourceResolver", () => {
  it("takes main.js from the bundle source and everything else from the root", () => {
    const sourceFor = createSourceResolver("C:\\repo", "C:\\repo\\build-diag\\main-dev.js");
    expect(sourceFor("main.js")).toBe("C:\\repo\\build-diag\\main-dev.js");
    expect(sourceFor("manifest.json")).toBe("C:\\repo\\manifest.json");
  });

  it("falls back to the repository root when no bundle source is given", () => {
    const sourceFor = createSourceResolver("C:\\repo", null);
    expect(sourceFor("main.js")).toBe("C:\\repo\\main.js");
  });
});

describe("withPluginEnabled", () => {
  it("appends a missing plugin and reports the change", () => {
    expect(withPluginEnabled(["a"], "mineral")).toEqual({ list: ["a", "mineral"], changed: true });
  });

  it("leaves an enabled plugin untouched", () => {
    const list = ["mineral", "a"];
    expect(withPluginEnabled(list, "mineral")).toEqual({ list, changed: false });
  });

  it("replaces a non-list registry with a single-entry list", () => {
    expect(withPluginEnabled(null, "mineral")).toEqual({ list: ["mineral"], changed: true });
  });
});
