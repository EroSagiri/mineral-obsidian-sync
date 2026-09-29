import { afterEach, describe, expect, it } from "vitest";
import type { App, Editor } from "obsidian";
import { TFile, resetRequestUrlHandler, setRequestUrlHandler } from "../../../test/obsidian";
import { DEFAULT_SETTINGS, type R2SyncSettings } from "../../settings";
import { HOT_SELF_TEST_FALLBACK_ROOT, HOT_SELF_TEST_ROOT, hotScenarioNames, runHotSelfTest } from "./hot-scenarios";
import { createVaultPathFilter } from "../../sync/ignore";

/**
 * The hot self-test's own control flow.
 *
 * What a device check must never do is leave the *harness* as the interesting part. These tests pin the
 * two properties that make the report trustworthy without a device: an unconfigured run fails exactly
 * one scenario and skips the rest, and an unreachable Gateway produces per-scenario failures instead of
 * an exception — plus the safety property that every local path it creates is inside the namespace the
 * sync filter ignores.
 */

function fakeEditor(value = ""): Editor {
  return {
    getValue: () => value,
    setValue: (text: string) => { value = text; },
    transaction: () => {},
  } as unknown as Editor;
}

function fakeApp(options: { hiddenIndexed?: boolean } = {}): { app: App; created: string[] } {
  const files = new Map<string, TFile>();
  const blobs = new Map<string, string>();
  const folders = new Set<string>();
  const created: string[] = [];
  const hiddenIndexed = options.hiddenIndexed ?? true;
  const indexed = (path: string): boolean => hiddenIndexed || !path.startsWith(".");
  const vault = {
    configDir: ".obsidian",
    adapter: {
      exists: async (path: string) => blobs.has(path) || files.has(path) || folders.has(path),
      mkdir: async (path: string) => { folders.add(path); },
      // A write lands on disk; whether Obsidian's index sees it is what the device decides.
      write: async (path: string, text: string) => {
        blobs.set(path, text);
        if (indexed(path)) files.set(path, Object.assign(new TFile(), { path }));
      },
      read: async (path: string) => blobs.get(path) ?? "",
      remove: async (path: string) => { blobs.delete(path); files.delete(path); folders.delete(path); },
      stat: async () => ({ size: 0, mtime: 0, ctime: 0 }),
    },
    getFileByPath: (path: string) => (indexed(path) ? files.get(path) ?? null : null),
    createFolder: async (path: string) => { folders.add(path); return undefined as never; },
    create: async (path: string, text: string) => {
      // Android refuses to create inside a dot-directory, which is why the harness probes for a root it
      // can actually use instead of assuming one.
      if (!indexed(path)) throw new Error("File already exists.");
      const file = Object.assign(new TFile(), { path });
      blobs.set(path, text);
      files.set(path, file);
      created.push(path);
      return file;
    },
    delete: async (file: TFile) => { blobs.delete(file.path); files.delete(file.path); },
    getFiles: () => [...files.values()].filter(file => indexed(file.path)),
  };
  const workspace = {
    getLeaf: () => ({ openFile: async () => undefined, view: { editor: fakeEditor() }, detach: () => undefined }),
    getLeavesOfType: () => [],
    getActiveViewOfType: () => null,
  };
  return { app: { vault, workspace } as unknown as App, created };
}

function settings(overrides: Partial<R2SyncSettings> = {}): R2SyncSettings {
  return {
    ...DEFAULT_SETTINGS,
    endpoint: "https://account.r2.cloudflarestorage.com",
    bucket: "vault",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    gatewayEnabled: true,
    gatewayEndpoint: "https://gateway.test",
    gatewayToken: "token",
    ...overrides,
  };
}

afterEach(() => resetRequestUrlHandler());

describe("hot self-test control flow", () => {
  it("fails configuration and skips every other scenario when it is not configured", async () => {
    const { app } = fakeApp();
    const run = await runHotSelfTest({ app, settings: settings({ gatewayEnabled: false }) });
    expect(run.results.map(result => result.name)).toEqual(hotScenarioNames());
    const [configuration, ...rest] = run.results;
    expect(configuration.status).toBe("fail");
    expect(configuration.detail).toContain("Sync Gateway enabled");
    expect(rest.every(result => result.status === "skipped")).toBe(true);
    expect(run.root.startsWith(HOT_SELF_TEST_ROOT)).toBe(true);
  });

  it("contains an unreachable Gateway as per-scenario failures, never as an exception", async () => {
    setRequestUrlHandler(() => { throw new Error("network down"); });
    const { app } = fakeApp();
    const run = await runHotSelfTest({ app, settings: settings() });
    expect(run.results.map(result => result.name)).toEqual(hotScenarioNames());
    // Configuration is a settings question, so it still passes; the network failure shows up where the
    // network is actually used.
    expect(run.results[0].status).toBe("pass");
    expect(run.results[1].status).toBe("fail");
    expect(run.results[1].detail.length).toBeGreaterThan(0);
    // The cleanup scenario still runs: a failed diagnostic must not leave scratch behind.
    const cleanup = run.results.at(-1)!;
    expect(["pass", "fail"]).toContain(cleanup.status);
  });

  it("creates local files only inside the namespace the sync filter ignores", async () => {
    setRequestUrlHandler(() => { throw new Error("network down"); });
    const { app, created } = fakeApp();
    await runHotSelfTest({ app, settings: settings() });
    expect(created.length).toBeGreaterThan(0);
    for (const path of created) expect(path.startsWith(HOT_SELF_TEST_ROOT)).toBe(true);
  });

  it("falls back to a visible root on a device that will not index a hidden one", async () => {
    // Android's Obsidian writes a dot-directory happily and then leaves it out of the vault index, so
    // nothing under it can be opened in a leaf. The fallback has to be visible — and therefore it has to
    // be a path the sync filter still refuses to treat as user content.
    setRequestUrlHandler(() => { throw new Error("network down"); });
    const { app, created } = fakeApp({ hiddenIndexed: false });
    const run = await runHotSelfTest({ app, settings: settings() });

    expect(run.root.startsWith(HOT_SELF_TEST_FALLBACK_ROOT)).toBe(true);
    const filter = createVaultPathFilter({ ignoredPaths: [] });
    // Every file this run created — including the probe that made the choice — must be invisible to the
    // sync engine, or a diagnostic run would upload its own scratch notes.
    expect(created.length).toBeGreaterThan(0);
    for (const path of created) expect(filter.ignores(path), `${path} must never be synced as user content`).toBe(true);
    const scenarioFiles = created.filter(path => path.startsWith(run.root));
    expect(scenarioFiles.length, "the scenarios must run inside the chosen root").toBeGreaterThan(0);
    for (const path of scenarioFiles) expect(path.startsWith(HOT_SELF_TEST_FALLBACK_ROOT), `${path} must be in the fallback root`).toBe(true);
    const configuration = run.results.find(result => result.name === "hot-configuration")!;
    expect(JSON.stringify(configuration.observations)).toContain("hidden:indexed=FAILED");
    expect(JSON.stringify(configuration.observations)).toContain("visible:indexed=ok");
  });
});


