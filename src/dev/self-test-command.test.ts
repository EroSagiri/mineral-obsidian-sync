import { afterEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { TFile, resetRequestUrlHandler, setRequestUrlHandler } from "../../test/obsidian";
import { DEFAULT_SETTINGS, type R2SyncSettings } from "../settings";
import { HOT_SELF_TEST_FALLBACK_ROOT } from "./integration/hot-scenarios";
import { registerDevelopmentSelfTests } from "./self-test-command";

/**
 * The marker trigger.
 *
 * A phone on a desk is locked, and a locked phone cannot open a command palette. That makes the file
 * trigger the *only* way the most valuable check — the hot path on a real Android device — can run
 * without a human standing by. Its two failure modes are both silent: a marker that is never noticed,
 * and a marker that is noticed on every start and loops forever. Both are pinned here.
 */

function hostWithMarker(markerPresent: boolean) {
  const files = new Map<string, string>();
  const removed: string[] = [];
  const written: string[] = [];
  if (markerPresent) files.set(`${HOT_SELF_TEST_FALLBACK_ROOT}RUN-HOT-SELFTEST.md`, "run\n");
  const vault = {
    configDir: ".obsidian",
    adapter: {
      exists: async (path: string) => files.has(path),
      mkdir: async () => undefined,
      write: async (path: string, text: string) => { written.push(path); files.set(path, text); },
      read: async (path: string) => files.get(path) ?? "",
      remove: async (path: string) => { removed.push(path); files.delete(path); },
      stat: async () => ({ size: 1, mtime: 0, ctime: 0 }),
    },
    getFileByPath: (path: string) => (files.has(path) ? Object.assign(new TFile(), { path }) : null),
    create: async (path: string) => { files.set(path, ""); return Object.assign(new TFile(), { path }); },
    delete: async (file: TFile) => { files.delete(file.path); },
    getFiles: () => [],
  };
  const commands: string[] = [];
  const statuses: string[] = [];
  const settings: R2SyncSettings = { ...DEFAULT_SETTINGS, endpoint: "https://r2.example", bucket: "mineral", hotSyncEnabled: true, gatewayEnabled: true, gatewayEndpoint: "https://sync.example", gatewayToken: "t" };
  return {
    removed,
    written,
    commands,
    statuses,
    files,
    host: {
      app: { vault, workspace: { getLeaf: () => ({ openFile: async () => undefined, view: {}, detach: () => undefined }), getLeavesOfType: () => [], getActiveViewOfType: () => null } } as unknown as App,
      settings,
      pluginDir: ".obsidian/plugins/mineral-obsidian-sync",
      addCommand: (command: { id: string }) => { commands.push(command.id); return command; },
      setStatus: (text: string) => { statuses.push(text); },
    },
  };
}

describe("the file-triggered self-test", () => {
  afterEach(() => { resetRequestUrlHandler(); });

  /** The poll is a device affordance; tests do not wait two seconds per attempt. */
  const fastPoll = { attempts: 20, delayMs: 25 };

  it("registers the commands and does nothing without a marker", async () => {
    const { host, removed, written, commands } = hostWithMarker(false);
    registerDevelopmentSelfTests(host, fastPoll);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(commands).toContain("r2-sync-dev-hot-self-test");
    expect(removed).toEqual([]);
    expect(written).toEqual([]);
  });

  it("consumes the marker before running, so a crash cannot become a loop", async () => {
    setRequestUrlHandler(() => { throw new Error("network down"); });
    const { host, removed, statuses } = hostWithMarker(true);
    registerDevelopmentSelfTests(host, fastPoll);

    // The marker is gone immediately — the run that follows is asynchronous and may take a minute on a
    // device, which is exactly why the marker cannot be left behind to trigger again on the next start.
    for (let attempt = 0; attempt < 100 && removed.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    expect(removed).toEqual([`${HOT_SELF_TEST_FALLBACK_ROOT}RUN-HOT-SELFTEST.md`]);

    // And the run really was started — it announces itself before its first scenario — so the trigger is
    // not merely deleting files.
    for (let attempt = 0; attempt < 100 && !statuses.includes("… hot self-test"); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    expect(statuses).toContain("… hot self-test");
  }, 20_000);

  it("finds a marker that appears after load, instead of looking exactly once", async () => {
    // `onload` runs before a mobile vault can necessarily answer for a file that was pushed onto the
    // filesystem a moment earlier, and one missed check is indistinguishable from "no marker was
    // requested" — which is how a device run ends up sitting there with its marker untouched.
    setRequestUrlHandler(() => { throw new Error("network down"); });
    const { host, removed, files } = hostWithMarker(false);
    registerDevelopmentSelfTests(host, { attempts: 40, delayMs: 25 });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(removed).toEqual([]);

    files.set(`${HOT_SELF_TEST_FALLBACK_ROOT}RUN-HOT-SELFTEST.md`, "run\n");
    for (let attempt = 0; attempt < 100 && removed.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    expect(removed).toEqual([`${HOT_SELF_TEST_FALLBACK_ROOT}RUN-HOT-SELFTEST.md`]);
  }, 20_000);

  it("still accepts the extensionless marker an already-deployed tool would drop", async () => {
    // The `.md` name exists because Android's adapter will not answer for a file it does not index, but a
    // marker already pushed under the old name must not silently stop working.
    setRequestUrlHandler(() => { throw new Error("network down"); });
    const { host, removed, files } = hostWithMarker(false);
    files.set(`${HOT_SELF_TEST_FALLBACK_ROOT}RUN-HOT-SELFTEST`, "run\n");
    registerDevelopmentSelfTests(host, { attempts: 40, delayMs: 25 });
    for (let attempt = 0; attempt < 100 && removed.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    expect(removed).toEqual([`${HOT_SELF_TEST_FALLBACK_ROOT}RUN-HOT-SELFTEST`]);
  }, 20_000);
});




