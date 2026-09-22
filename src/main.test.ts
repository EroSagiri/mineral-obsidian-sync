import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, Platform } from "obsidian";
import R2PersonalSyncPlugin from "./main";
import { DEFAULT_SETTINGS } from "./settings";
import { ignorePolicyFingerprint } from "./sync/ignore";
import { remoteIdentity } from "./remote/r2-client";
import type { R2SyncSettings } from "./settings";
import type { LocalEntry, PreviousEntry } from "./sync/types";

/**
 * The Android editor-save path, driven directly.
 *
 * This is where the "it only syncs after I type something" defect lived: an owed editor save that could
 * not run at that instant was discarded with no record, and because every other trigger in the plugin
 * reads the *file*, the path stayed invisible until a new keystroke armed a new save. These tests pin
 * the lifecycle that replaced it, plus the two redundant-cycle suppressions that came with it.
 */

type Stamp = { size: number; mtime: number };
type StubView = { file: { path: string } | null; editor: { getValue(): string }; save(): Promise<void>; saved: number };

/** Obsidian resolves to the test stubs at run time, but to the real types for `tsc`. */
const newView = (): StubView => new (MarkdownView as unknown as new () => StubView)();
const newPlugin = (app: unknown): Record<string, unknown> => new (R2PersonalSyncPlugin as unknown as new (app: unknown) => object)(app) as Record<string, unknown>;

/** The private surface these tests drive. */
interface Internals {
  app: {
    vault: { adapter: { stat(path: string): Promise<Stamp | null> }; read(file: { path: string }): Promise<string> };
    workspace: { getLeavesOfType(): Array<{ view: StubView }> };
  };
  settings: R2SyncSettings;
  scheduler: { markLocalPaths(paths: string[], ignores: (key: string) => boolean, reason?: string): boolean };
  stateStore: { loadAll(): Promise<Map<string, PreviousEntry>> };
  androidPendingEditorSaves: Set<string>;
  androidEditorWriteStamps: Map<string, Stamp>;
  scheduleAndroidEditorSave(path: string): void;
  flushAndroidEditorSave(path: string, force?: boolean): Promise<void>;
  flushPendingAndroidEditorSaves(trigger: string, force?: boolean): Promise<string[]>;
  flushDivergentEditorBuffers(): Promise<string[]>;
  unsyncedLocalDrift(current: Map<string, LocalEntry>, changed: string[]): Promise<string[]>;
  markUnlessOwnEditorWrite(path: string): Promise<void>;
  registerVaultListeners(): void;
}

function harness(options: { buffer?: string; before?: Stamp | null; after?: Stamp | null } = {}) {
  const settings = { ...DEFAULT_SETTINGS, endpoint: "https://r2.example", bucket: "mineral" };
  const marked: Array<{ path: string; reason: string | undefined }> = [];
  const notices: string[] = [];
  const handlers = new Map<string, () => void>();
  /** The Vault's current view of the file; a save moves it, exactly as a real write would. */
  const state: { current: Stamp | null } = { current: options.before === undefined ? { size: 5, mtime: 100 } : options.before };
  const view = newView();
  view.file = { path: "note.md" };
  view.editor = { getValue: () => options.buffer ?? "" };
  view.save = async () => {
    view.saved += 1;
    state.current = options.after === undefined ? { size: 9, mtime: 200 } : options.after;
  };
  const views: StubView[] = [view];
  const app = {
    vault: {
      adapter: { stat: async () => state.current },
      read: async () => options.buffer ?? "",
      on: (event: string, handler: () => void) => { handlers.set(`vault:${event}`, handler); return {}; },
    },
    workspace: {
      getLeavesOfType: () => views.map((candidate) => ({ view: candidate })),
      on: (event: string, handler: () => void) => { handlers.set(`workspace:${event}`, handler); return {}; },
    },
  };
  const plugin = newPlugin(app) as unknown as Internals;
  plugin.app = app as unknown as Internals["app"];
  plugin.settings = settings;
  plugin.scheduler = { markLocalPaths: (paths, _ignores, reason) => { for (const path of paths) marked.push({ path, reason }); return true; } };
  plugin.stateStore = { loadAll: async () => new Map() };
  (plugin as unknown as { debug(message: string): void }).debug = (message) => { notices.push(message); };
  return { plugin, view, views, marked, notices, handlers, settings, state };
}

/** A baseline as the state store records one, so the drift filter is exercised against real shapes. */
function baselineFor(settings: R2SyncSettings, path: string, local: Stamp, etag: string): PreviousEntry {
  return {
    key: path,
    local: { size: local.size, mtime: local.mtime },
    remote: { size: local.size, etag },
    syncedAt: 1,
    remoteIdentity: remoteIdentity(settings),
    ignorePolicy: ignorePolicyFingerprint(settings),
  };
}

describe("android editor save lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as Record<string, unknown>).window = globalThis;
    (globalThis as Record<string, unknown>).document = { visibilityState: "visible" };
    Platform.isAndroidApp = true;
  });
  afterEach(() => {
    vi.useRealTimers();
    Platform.isAndroidApp = false;
  });

  it("writes the buffer after the quiet period and marks the shorter editor-change reason", async () => {
    const env = harness();
    env.plugin.scheduleAndroidEditorSave("note.md");
    await vi.advanceTimersByTimeAsync(500);

    expect(env.view.saved).toBe(1);
    expect(env.marked).toEqual([{ path: "note.md", reason: "editor-change" }]);
  });

  it("keeps the buffer owed, and writes it later, when the app is not visible", async () => {
    const env = harness();
    env.plugin.scheduleAndroidEditorSave("note.md");

    // The app goes away before the 500 ms quiet period elapses.
    (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(500);

    // A save that cannot run right now is kept, not discarded: nothing else can see the buffer.
    expect(env.view.saved).toBe(0);
    expect(env.plugin.androidPendingEditorSaves.has("note.md")).toBe(true);

    // Coming back writes it, before any reconcile can read the file it was not in.
    (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState = "visible";
    expect(await env.plugin.flushPendingAndroidEditorSaves("visible")).toEqual(["note.md"]);
    expect(env.view.saved).toBe(1);
    expect(env.plugin.androidPendingEditorSaves.size).toBe(0);
    expect(env.marked).toEqual([{ path: "note.md", reason: "editor-change" }]);
  });

  it("writes an owed buffer when the app goes away, even though the document is already hidden", async () => {
    const env = harness();
    env.plugin.scheduleAndroidEditorSave("note.md");
    (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState = "hidden";

    // `force` is what turns going to the background into a save point rather than a way to lose the edit.
    expect(await env.plugin.flushPendingAndroidEditorSaves("hidden", true)).toEqual(["note.md"]);

    expect(env.view.saved).toBe(1);
    expect(env.marked).toEqual([{ path: "note.md", reason: "editor-change" }]);
  });

  it("writes through whatever view holds the path now, not the one that scheduled the save", async () => {
    const env = harness();
    env.plugin.scheduleAndroidEditorSave("note.md");

    // The leaf is reused: the view that armed the timer no longer shows the note, and a new view does.
    env.view.file = { path: "other.md" };
    const replacement = newView();
    replacement.file = { path: "note.md" };
    replacement.editor = env.view.editor;
    replacement.save = async () => { replacement.saved += 1; env.state.current = { size: 9, mtime: 200 }; };
    env.views.push(replacement);

    await vi.advanceTimersByTimeAsync(500);

    expect(replacement.saved).toBe(1);
    expect(env.view.saved).toBe(0);
    expect(env.marked).toEqual([{ path: "note.md", reason: "editor-change" }]);
  });

  it("marks the path when no view holds it any more, instead of doing nothing", async () => {
    const env = harness();
    env.plugin.scheduleAndroidEditorSave("note.md");
    env.views.length = 0;

    await vi.advanceTimersByTimeAsync(500);

    // The buffer died with its view, so the only useful action left is to make a cycle re-read the file.
    expect(env.marked).toEqual([{ path: "note.md", reason: "local-event" }]);
    expect(env.plugin.androidPendingEditorSaves.size).toBe(0);
  });

  it("marks the path when the save itself fails", async () => {
    const env = harness();
    env.view.save = async () => { throw new Error("view torn down"); };
    env.plugin.scheduleAndroidEditorSave("note.md");
    await vi.advanceTimersByTimeAsync(500);

    expect(env.marked).toEqual([{ path: "note.md", reason: "local-event" }]);
    expect(env.notices.some((message) => message.includes("save failed"))).toBe(true);
  });

  it("flushes owed buffers when the user leaves a note", async () => {
    const env = harness();
    env.plugin.registerVaultListeners();
    const leaving = env.handlers.get("workspace:active-leaf-change");
    expect(leaving, "active-leaf-change must be observed for the flush to happen").toBeTypeOf("function");

    env.plugin.scheduleAndroidEditorSave("note.md");
    leaving!();
    await vi.advanceTimersByTimeAsync(0);

    expect(env.view.saved).toBe(1);
    expect(env.marked).toEqual([{ path: "note.md", reason: "editor-change" }]);
  });

  it("does not report a save that wrote nothing, so a reloaded download costs no extra cycle", async () => {
    // Android reloads a downloaded file into the editor, which fires editor-change for a buffer that
    // already matches the file: the write is a no-op and must not be announced as a local change.
    const env = harness({ before: { size: 9, mtime: 200 }, after: { size: 9, mtime: 200 } });
    env.plugin.scheduleAndroidEditorSave("note.md");
    await vi.advanceTimersByTimeAsync(500);

    expect(env.view.saved).toBe(1);
    expect(env.marked).toEqual([]);
    expect(env.notices).toContain("android editor-change noop path-digest=aeaa4e78");
  });

  it("suppresses the Vault event of its own save so it cannot replace the shorter debounce", async () => {
    const env = harness();
    await env.plugin.flushAndroidEditorSave("note.md");
    expect(env.marked).toEqual([{ path: "note.md", reason: "editor-change" }]);

    // The save's own `modify` event arrives afterwards and must not add a second, slower mark.
    env.marked.length = 0;
    await env.plugin.markUnlessOwnEditorWrite("note.md");
    expect(env.marked).toEqual([]);
    expect(env.notices).toContain("android editor-change own-write event suppressed path-digest=aeaa4e78");
  });

  it("still marks a Vault event that is newer than its own save", async () => {
    const env = harness();
    await env.plugin.flushAndroidEditorSave("note.md");
    // The user typed again, so the file no longer matches what this plugin wrote.
    env.state.current = { size: 20, mtime: 300 };
    env.marked.length = 0;
    await env.plugin.markUnlessOwnEditorWrite("note.md");

    expect(env.marked).toEqual([{ path: "note.md", reason: undefined }]);
  });

  it("writes a diverged buffer that no event ever reported", async () => {
    // An edit made before this plugin instance existed leaves no pending record; the buffer comparison
    // is what keeps it from staying invisible until the user types again.
    const env = harness({ buffer: "buffer text" });
    env.plugin.app.vault.read = async () => "file text";

    expect(await env.plugin.flushDivergentEditorBuffers()).toEqual(["note.md"]);
    expect(env.view.saved).toBe(1);
    expect(env.marked).toEqual([{ path: "note.md", reason: "editor-change" }]);
  });

  it("leaves a buffer that matches its file alone", async () => {
    const env = harness({ buffer: "same text" });
    env.plugin.app.vault.read = async () => "same text";

    expect(await env.plugin.flushDivergentEditorBuffers()).toEqual([]);
    expect(env.view.saved).toBe(0);
    expect(env.marked).toEqual([]);
  });

  it("ignores drift that the recorded baseline already describes", async () => {
    const env = harness();
    // This is the version a download just committed: the metadata moved, but nothing is unsynced.
    env.plugin.stateStore = { loadAll: async () => new Map([["note.md", baselineFor(env.settings, "note.md", { size: 9, mtime: 200 }, "E")]]) };

    expect(await env.plugin.unsyncedLocalDrift(new Map([["note.md", { key: "note.md", size: 9, mtime: 200 }]]), ["note.md"])).toEqual([]);
  });

  it("reports drift the baseline does not describe, and drift with no baseline at all", async () => {
    const env = harness();
    env.plugin.stateStore = { loadAll: async () => new Map([["known.md", baselineFor(env.settings, "known.md", { size: 9, mtime: 200 }, "E")]]) };

    const drifted = await env.plugin.unsyncedLocalDrift(new Map([
      ["known.md", { key: "known.md", size: 9, mtime: 999 }],
      ["unrecorded.md", { key: "unrecorded.md", size: 1, mtime: 1 }],
    ]), ["known.md", "unrecorded.md"]);

    expect(drifted).toEqual(["known.md", "unrecorded.md"]);
  });

  it("reports a vanished file as drift regardless of any baseline", async () => {
    const env = harness();
    env.plugin.stateStore = { loadAll: async () => new Map([["gone.md", baselineFor(env.settings, "gone.md", { size: 9, mtime: 200 }, "E")]]) };

    expect(await env.plugin.unsyncedLocalDrift(new Map(), ["gone.md"])).toEqual(["gone.md"]);
  });

  it("falls back to reporting every drifted path when the baseline cannot be read", async () => {
    const env = harness();
    env.plugin.stateStore = { loadAll: async () => { throw new Error("indexeddb unavailable"); } };

    expect(await env.plugin.unsyncedLocalDrift(new Map([["note.md", { key: "note.md", size: 9, mtime: 200 }]]), ["note.md"])).toEqual(["note.md"]);
  });
});
