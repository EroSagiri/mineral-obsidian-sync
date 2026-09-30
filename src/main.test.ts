import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, Menu, Notice, Platform } from "obsidian";
import { FakeElement, flush } from "../test/dom";
import R2PersonalSyncPlugin from "./main";
import { DEFAULT_SETTINGS } from "./settings";
import { ignorePolicyFingerprint } from "./sync/ignore";
import { remoteIdentity } from "./remote/r2-client";
import { CONFLICT_PROTOCOL_VERSION, type AutoMergeStatus, type ConflictRecord, type ResolutionIntent } from "./conflict/types";
import { presentConflict } from "./ui/conflict-presentation";
import { observeRemoteDelta } from "./sync/remote-delta";
import type { SyncHistoryEntry } from "./history/types";
import type { R2SyncSettings } from "./settings";
import type { FailureClass, ResultCounts, SchedulerState } from "./scheduler/types";
import type { LocalEntry, PreviousEntry, RemoteEntry, SyncOperation } from "./sync/types";

/**
 * The Android editor-save path, driven directly.
 *
 * This is where the "it only syncs after I type something" defect lived: an owed editor save that could
 * not run at that instant was discarded with no record, and because every other trigger in the plugin
 * reads the *file*, the path stayed invisible until a new keystroke armed a new save. These tests pin
 * the lifecycle that replaced it, plus the two redundant-cycle suppressions that came with it.
 */

type Stamp = { size: number; mtime: number };
type StubView = { file: { path: string; extension?: string } | null; editor: { getValue(): string }; save(): Promise<void>; saved: number };

/** Obsidian resolves to the test stubs at run time, but to the real types for `tsc`. */
const newView = (): StubView => new (MarkdownView as unknown as new () => StubView)();
const newPlugin = (app: unknown): Record<string, unknown> => new (R2PersonalSyncPlugin as unknown as new (app: unknown) => object)(app) as Record<string, unknown>;

/** The private surface these tests drive. */
interface Internals {
  app: {
    vault: { adapter: { stat(path: string): Promise<Stamp | null>; read(path: string): Promise<string> }; read(file: { path: string }): Promise<string> };
    workspace: { getLeavesOfType(): Array<{ view: StubView }> };
  };
  settings: R2SyncSettings;
  scheduler: {
    markLocalPaths(paths: string[], ignores: (key: string) => boolean, reason?: string): boolean;
    diagnostics?(): { lastFailureClass?: FailureClass; currentState?: string; lastCycleReason?: string; pendingDirtyCount?: number; pendingRemoteDeltaCount?: number };
    requestReconcile?(reason: string): void;
    refreshStatus?(): void;
  };
  stateStore: { loadAll(): Promise<Map<string, PreviousEntry>> };
  statusBar?: FakeElement;
  lastConflictCount: number;
  androidPendingEditorSaves: Set<string>;
  androidEditorWriteStamps: Map<string, Stamp>;
  scheduleAndroidEditorSave(path: string): void;
  flushAndroidEditorSave(path: string, force?: boolean): Promise<void>;
  flushPendingAndroidEditorSaves(trigger: string, force?: boolean): Promise<string[]>;
  flushDivergentEditorBuffers(): Promise<string[]>;
  unsyncedLocalDrift(current: Map<string, LocalEntry>, changed: string[]): Promise<string[]>;
  markUnlessOwnEditorWrite(path: string): Promise<void>;
  registerVaultListeners(): void;
  setSchedulerStatus(state: SchedulerState, counts: ResultCounts): void;
  onStatusClick(): void;
  reportStatusDetails(): void;
  openConflictResolver(): Promise<void>;
}

function harness(options: { buffer?: string; before?: Stamp | null; after?: Stamp | null } = {}) {
  const settings = { ...DEFAULT_SETTINGS, endpoint: "https://r2.example", bucket: "mineral" };
  const marked: Array<{ path: string; reason: string | undefined }> = [];
  const notices: string[] = [];
  const handlers = new Map<string, () => void>();
  /** The Vault's current view of the file; a save moves it, exactly as a real write would. */
  const state: { current: Stamp | null } = { current: options.before === undefined ? { size: 5, mtime: 100 } : options.before };
  const view = newView();
  view.file = { path: "note.md", extension: "md" };
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
      // The plugin asks for the active file and its pane when it adopts what is already open.
      getActiveFile: () => views[0]?.file ?? null,
      getActiveViewOfType: () => views[0] ?? null,
      on: (event: string, handler: () => void) => { handlers.set(`workspace:${event}`, handler); return {}; },
    },
  };
  const plugin = newPlugin(app) as unknown as Internals;
  plugin.app = app as unknown as Internals["app"];
  plugin.settings = settings;
  plugin.scheduler = { markLocalPaths: (paths, _ignores, reason) => { for (const path of paths) marked.push({ path, reason }); return true; }, refreshStatus: () => undefined };
  plugin.stateStore = { loadAll: async () => new Map() };
  (plugin as unknown as { debug(message: string): void }).debug = (message) => { notices.push(message); };
  return {
    plugin, view, views, marked, notices, handlers, settings, state,
    /** Set the hot layer's switches on the plugin's own settings object, before wiring decisions read it. */
    attachHotSettings(overrides: Partial<R2SyncSettings>): void { Object.assign(settings, overrides); },
  };
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

describe("hot ownership from the cold path's point of view", () => {
  it("shuts down the hot coordinator before an unloaded plugin instance can echo events", () => {
    const env = harness();
    const calls: string[] = [];
    const plugin = env.plugin as unknown as {
      onunload(): void;
      hotCoordinator?: { shutdown(): void };
      hotOpenPath?: string;
      scheduler?: { stop(): void };
      gateway?: { stop(): void };
    };
    plugin.hotCoordinator = { shutdown: () => calls.push("hot-shutdown") };
    plugin.hotOpenPath = "note.md";
    plugin.scheduler = { stop: () => calls.push("scheduler-stop") };
    plugin.gateway = { stop: () => calls.push("gateway-stop") };

    plugin.onunload();

    expect(calls).toContain("hot-shutdown");
    expect(calls).toContain("gateway-stop");
    expect(plugin.hotCoordinator).toBeUndefined();
    expect(plugin.hotOpenPath).toBeUndefined();
  });

  it("shuts down a pending hot transport when hot sync is disabled", async () => {
    const env = harness();
    const calls: string[] = [];
    env.attachHotSettings({ hotSyncEnabled: false, gatewayEnabled: true });
    const plugin = env.plugin as unknown as {
      refreshHotSync(): Promise<void>;
      closeHotDocument(): Promise<void>;
      hotCoordinator?: { shutdown(): void };
      hotOpenPath?: string;
    };
    plugin.hotCoordinator = { shutdown: () => calls.push("hot-shutdown") };
    plugin.hotOpenPath = "note.md";
    plugin.closeHotDocument = async () => { calls.push("handoff-attempted"); };

    await plugin.refreshHotSync();

    expect(calls).toEqual(["handoff-attempted", "hot-shutdown"]);
    expect(plugin.hotCoordinator).toBeUndefined();
    expect(plugin.hotOpenPath).toBeUndefined();
  });

  /**
   * A recording stand-in for the plugin's hot coordinator.
   *
   * The fence is the only thing the cold path asks about, so the stub is deliberately tiny: what is
   * under test is whether the *plugin* asks — on every entry — before it registers a local change.
   */
  function hotStub(fenced: string[], renameOutcome: "applied" | "conflict" = "applied") {
    const deferred: string[] = [];
    const renamed: Array<{ from: string; to: string }> = [];
    return {
      deferred,
      renamed,
      stub: {
        isFenced: (key: string) => fenced.includes(key),
        noteDeferred: (key: string) => { deferred.push(key); },
        // Deleting a file ends its hot state; the tests exercise that handler, so the stub answers it.
        forget: async (key: string) => { void key; },
        rename: async (from: string, to: string) => {
          renamed.push({ from, to });
          return renameOutcome === "applied"
            ? { protocol: 1, operationId: "r", type: "rename" as const, outcome: "applied" as const, phase: "acked" as const, canonicalPath: to, fromPath: from, binding: null, identity: { documentId: "doc", epoch: 2 } }
            : { protocol: 1, operationId: "r", type: "rename" as const, outcome: "conflict" as const, reason: "target-exists" as const, phase: "failed" as const, canonicalPath: to, fromPath: from, binding: null };
        },
      },
    };
  }

  /** The rename path is async but timer-free: microtasks are all it needs to settle. */
  const settleHotRename = () => new Promise<void>(resolve => setTimeout(resolve, 0));

  const attach = (plugin: Internals, stub: unknown): void => {
    (plugin as unknown as { hotCoordinator?: unknown }).hotCoordinator = stub;
  };

  it("stays entirely out of the way when the Gateway is disabled", async () => {
    // The design's promise for a deployment without a Gateway: existing cold sync behaviour, unchanged.
    // The mechanism is that nothing hot is ever constructed, so there is nothing to fence and nothing to
    // talk to — which is what this asserts, at the entry point that would build it.
    const env = harness();
    env.attachHotSettings({ hotSyncEnabled: true, gatewayEnabled: false });
    const internals = env.plugin as unknown as { refreshHotSync(): Promise<void>; hotCoordinator?: unknown; hotLastError?: string };
    await internals.refreshHotSync();
    expect(internals.hotCoordinator).toBeUndefined();
    // No attempt to reach a Gateway was even recorded as a failure: the feature is off, not broken.
    expect(internals.hotLastError).toBeUndefined();

    // And the cold path is exactly as it was: a local change is marked, planned and uploaded as usual.
    await env.plugin.markUnlessOwnEditorWrite("note.md");
    expect(env.marked.map(entry => entry.path)).toEqual(["note.md"]);
  });

  it("takes the file already open hot, because enabling the feature produces no file-open event", async () => {
    // The bug this pins: the plugin only reacted to `file-open`, so the note that was already in front of
    // the user never became hot. The feature was working exactly as written and looked completely broken.
    const env = harness();
    const opened: string[] = [];
    const hot = hotStub([]);
    attach(env.plugin, {
      ...hot.stub,
      open: async (input: { canonicalPath: string }) => { opened.push(input.canonicalPath); return { outcome: "hot" }; },
    });
    (env.plugin as unknown as { openActiveFileHot(): void }).openActiveFileHot();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(opened).toEqual(["note.md"]);
  });

  it("serializes rapid file switches and never accepts the old room for a reused editor", async () => {
    const env = harness({ buffer: "local" });
    const opened: string[] = [];
    const guards: Array<() => boolean> = [];
    let releaseFirst!: () => void;
    const firstAcquire = new Promise<void>(resolve => { releaseFirst = resolve; });
    attach(env.plugin, {
      open: async (input: { canonicalPath: string; isCurrent?: () => boolean }) => {
        opened.push(input.canonicalPath);
        guards.push(input.isCurrent!);
        if (input.canonicalPath === "note.md") await firstAcquire;
        return { outcome: "hot" };
      },
      close: async () => ({ outcome: "handed-off" }),
      rebind: () => undefined,
    });
    const plugin = env.plugin as unknown as {
      openHotDocument(file: { path: string; extension: string }): Promise<void>;
      hotOpenPath?: string;
    };

    const first = plugin.openHotDocument({ path: "note.md", extension: "md" });
    await new Promise(resolve => setTimeout(resolve, 0));
    // Obsidian reuses the pane and its Editor instance while the first acquire is still in flight.
    env.view.file = { path: "other.md", extension: "md" };
    const second = plugin.openHotDocument({ path: "other.md", extension: "md" });

    expect(guards[0]()).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);

    expect(opened).toEqual(["note.md", "other.md"]);
    expect(guards[1]()).toBe(true);
    expect(plugin.hotOpenPath).toBe("other.md");
  });

  it("does not register a cold change for a path a hot session owns", async () => {
    const env = harness();
    const hot = hotStub(["hot.md"]);
    attach(env.plugin, hot.stub);

    await env.plugin.markUnlessOwnEditorWrite("hot.md");
    expect(env.marked).toEqual([]);
    expect(hot.deferred).toEqual(["hot.md"]);

    // A cold path in the same session is untouched by the fence.
    await env.plugin.markUnlessOwnEditorWrite("cold.md");
    expect(env.marked).toEqual([{ path: "cold.md", reason: undefined }]);
  });

  it("keeps create and delete of a hot path out of the cold plan", async () => {
    const env = harness();
    const hot = hotStub(["hot.md"]);
    attach(env.plugin, hot.stub);
    env.plugin.registerVaultListeners();

    (env.handlers.get("vault:create") as unknown as (file: { path: string }) => void)({ path: "hot.md" });
    (env.handlers.get("vault:delete") as unknown as (file: { path: string }) => void)({ path: "hot.md" });
    expect(env.marked).toEqual([]);
    expect(hot.deferred).toEqual(["hot.md", "hot.md"]);

    (env.handlers.get("vault:create") as unknown as (file: { path: string }) => void)({ path: "cold.md" });
    expect(env.marked).toEqual([{ path: "cold.md", reason: undefined }]);
  });

  it("turns a hot rename into a namespace operation and marks nothing", async () => {
    const env = harness();
    const hot = hotStub(["a.md"]);
    attach(env.plugin, hot.stub);
    env.plugin.registerVaultListeners();

    (env.handlers.get("vault:rename") as unknown as (file: { path: string }, oldPath: string) => void)({ path: "b.md" }, "a.md");
    await settleHotRename();

    expect(hot.renamed).toEqual([{ from: "a.md", to: "b.md" }]);
    // Nothing may be marked: the Vault writes the new path and tombstones the old one, so a cold mark
    // here would race the namespace operation and could upload content the room already owns.
    expect(env.marked).toEqual([]);
  });

  it("marks both paths when the hot rename is refused, because the file really did move", async () => {
    const env = harness();
    const hot = hotStub(["a.md"], "conflict");
    attach(env.plugin, hot.stub);
    env.plugin.registerVaultListeners();

    (env.handlers.get("vault:rename") as unknown as (file: { path: string }, oldPath: string) => void)({ path: "b.md" }, "a.md");
    await settleHotRename();

    expect(hot.renamed).toEqual([{ from: "a.md", to: "b.md" }]);
    // The old path is still fenced, so it is recorded as deferred rather than marked; the new path is a
    // genuine local change the cold path has to reconcile, because the namespace operation did not run.
    expect({ marked: env.marked.map(entry => entry.path), deferred: hot.deferred }).toEqual({ marked: ["b.md"], deferred: ["a.md"] });
  });

  it("marks an ordinary cold rename exactly as it always did", async () => {
    const env = harness();
    env.plugin.registerVaultListeners();
    (env.handlers.get("vault:rename") as unknown as (file: { path: string }, oldPath: string) => void)({ path: "b.md" }, "a.md");
    expect(env.marked.map(entry => entry.path)).toEqual(["a.md", "b.md"]);
  });

  it("keeps the cold behaviour identical when no hot layer is running", async () => {
    // The feature is additive: with hot sync off, every entry that marked before still marks.
    const env = harness();
    env.plugin.registerVaultListeners();
    await env.plugin.markUnlessOwnEditorWrite("note.md");
    (env.handlers.get("vault:create") as unknown as (file: { path: string }) => void)({ path: "new.md" });
    (env.handlers.get("vault:delete") as unknown as (file: { path: string }) => void)({ path: "gone.md" });
    expect(env.marked.map(entry => entry.path)).toEqual(["note.md", "new.md", "gone.md"]);
  });

  it("flags a write to a hot file that the bound buffer does not contain", async () => {
    const env = harness({ buffer: "typing in the buffer" });
    const flagged: string[] = [];
    const hot = hotStub(["note.md"]);
    attach(env.plugin, { ...hot.stub, flagExternalEdit: (path: string) => { flagged.push(path); return true; } });
    // The pane has to be a real MarkdownView: the plugin identifies the bound buffer by asking the view
    // for it, and a stand-in object would make this test pass for the wrong reason.
    const pane = newView();
    pane.file = { path: "note.md" } as never;
    pane.editor = { getValue: () => "typing in the buffer" } as never;
    env.views.push(pane);
    // The plugin reads the *adapter*, because that is what the Vault event is about.
    let disk = "the file as this plugin last saw it";
    env.plugin.app.vault.adapter.read = async () => disk;

    // The first look only records what the file holds: without a previous observation there is nothing to
    // compare against, and "unknown" must never be read as "someone else wrote it".
    await env.plugin.markUnlessOwnEditorWrite("note.md");
    expect(flagged).toEqual([]);

    // Someone else writes the file while the buffer is quiet: that is the case the rule exists for.
    // The new bytes match neither the buffer nor any snapshot this plugin owns, so the external write is
    // surfaced without any time-based grace window.
    disk = "something else wrote this file";
    await env.plugin.markUnlessOwnEditorWrite("note.md");

    // The external edit is surfaced and *not* registered as a cold change: the path stays hot-owned.
    expect(flagged).toEqual(["note.md"]);
    expect(env.marked).toEqual([]);
  });

  it("does not call our own autosave an external write, however soon the user types again", async () => {
    // The reported loop: resolve the conflict, type one character, conflict again. Obsidian writes the buffer
    // itself, and the buffer has usually moved on by the time that write lands — so disk-versus-buffer alone
    // fires on every save a moment after a keystroke.
    const env = harness({ buffer: "typed a bit more" });
    const flagged: string[] = [];
    const hot = hotStub(["note.md"]);
    attach(env.plugin, { ...hot.stub, flagExternalEdit: (path: string) => { flagged.push(path); return true; } });
    const pane = newView();
    pane.file = { path: "note.md" } as never;
    pane.editor = { getValue: () => "typed a bit more" } as never;
    env.views.push(pane);
    let disk = "typed";
    env.plugin.app.vault.adapter.read = async () => disk;

    await env.plugin.markUnlessOwnEditorWrite("note.md");
    // The autosave of what the user had typed lands, and one more character is already in the buffer.
    // Simulate the editor-change handler recording the intermediate buffer state ("typed a") before the
    // second write, exactly as the live plugin would.
    (env.plugin as unknown as { hotRecentBuffers: Map<string, { text: string; at: number }[]> }).hotRecentBuffers.set("note.md", [{ text: "typed a", at: Date.now() }]);
    disk = "typed a";
    await env.plugin.markUnlessOwnEditorWrite("note.md");

    expect(flagged).toEqual([]);
    expect(env.marked).toEqual([]);
  });

  it("does not let an expired buffer snapshot hide a later external write", async () => {
    const env = harness({ buffer: "current buffer" });
    const flagged: string[] = [];
    const hot = hotStub(["note.md"]);
    attach(env.plugin, { ...hot.stub, flagExternalEdit: (path: string) => { flagged.push(path); return true; } });
    const pane = newView();
    pane.file = { path: "note.md" } as never;
    pane.editor = { getValue: () => "current buffer" } as never;
    env.views.push(pane);
    let disk = "baseline";
    env.plugin.app.vault.adapter.read = async () => disk;

    await env.plugin.markUnlessOwnEditorWrite("note.md");
    (env.plugin as unknown as { hotRecentBuffers: Map<string, { text: string; at: number }[]> }).hotRecentBuffers.set("note.md", [
      { text: "old editor state", at: Date.now() - 60_001 },
    ]);
    disk = "old editor state";
    await env.plugin.markUnlessOwnEditorWrite("note.md");

    expect(flagged).toEqual(["note.md"]);
  });

  it("leaves the editor's own save alone while the buffer is merely ahead of the file", async () => {
    // The comparison is disk-versus-buffer on purpose. While the user types, the file is legitimately
    // behind the buffer for a moment; comparing with the CRDT instead would raise a conflict on every
    // ordinary save.
    const env = harness({ buffer: "typed but not yet flushed" });
    const flagged: string[] = [];
    const hot = hotStub(["note.md"]);
    attach(env.plugin, { ...hot.stub, flagExternalEdit: (path: string) => { flagged.push(path); return true; } });
    const pane = newView();
    pane.file = { path: "note.md" } as never;
    pane.editor = { getValue: () => "typed but not yet flushed" } as never;
    env.views.push(pane);
    env.plugin.app.vault.adapter.read = async () => "typed but not yet flushed";

    await env.plugin.markUnlessOwnEditorWrite("note.md");

    expect(flagged).toEqual([]);
    // It is still a hot path, so the cold path defers it rather than marking it.
    expect(env.marked).toEqual([]);
  });
});

describe("the hot socket adapter", () => {
  /** The smallest WebSocket that behaves like the platform's, including throwing on a premature send. */
  class FakeWebSocket {
    static readonly instances: FakeWebSocket[] = [];
    readonly sent: string[] = [];
    readyState = 0;
    closed = false;
    private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
    constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
    addEventListener(type: string, handler: (event: unknown) => void): void {
      const existing = this.listeners.get(type) ?? [];
      existing.push(handler);
      this.listeners.set(type, existing);
    }
    send(data: string): void {
      // This is the platform behaviour the adapter exists to absorb.
      if (this.readyState !== 1) throw new Error("InvalidStateError: still in CONNECTING state");
      this.sent.push(data);
    }
    close(): void { this.closed = true; this.readyState = 3; this.emit("close", {}); }
    open(): void { this.readyState = 1; this.emit("open", {}); }
    receive(data: string): void { this.emit("message", { data }); }
    private emit(type: string, event: unknown): void { for (const handler of this.listeners.get(type) ?? []) handler(event); }
  }

  interface Adapter { send(data: string): void; close(): void; onMessage(handler: (data: string) => void): void; onClose(handler: () => void): void }

  function adapter() {
    const previous = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    FakeWebSocket.instances.length = 0;
    const plugin = newPlugin({}) as unknown as { openHotSocket(url: string): Adapter };
    const socket = plugin.openHotSocket("wss://gateway.test/session?ticket=t");
    return { socket, underlying: FakeWebSocket.instances[0], restore: () => { (globalThis as Record<string, unknown>).WebSocket = previous; } };
  }

  it("holds frames until the handshake finishes instead of losing them to a CONNECTING throw", () => {
    const { socket, underlying, restore } = adapter();
    try {
      // The session may produce a frame before the socket opens — on a phone that window is real.
      expect(() => socket.send("first")).not.toThrow();
      expect(underlying.sent).toEqual([]);

      underlying.open();
      expect(underlying.sent).toEqual(["first"]);
      socket.send("second");
      expect(underlying.sent).toEqual(["first", "second"]);
    } finally { restore(); }
  });

  it("gives up on a handshake that never completes rather than queueing forever", () => {
    const { socket, underlying, restore } = adapter();
    try {
      for (let index = 0; index < 100; index++) socket.send(`frame-${index}`);
      // The socket is closed, so the session's durable outbox is what retries the work.
      expect(underlying.closed).toBe(true);
      expect(underlying.sent).toEqual([]);
    } finally { restore(); }
  });

  it("delivers text frames and a close notification", () => {
    const { socket, underlying, restore } = adapter();
    try {
      const messages: string[] = [];
      let closed = 0;
      socket.onMessage((data) => messages.push(data));
      socket.onClose(() => { closed += 1; });
      underlying.open();
      underlying.receive("{\"type\":\"welcome\"}");
      expect(messages).toEqual(["{\"type\":\"welcome\"}"]);
      socket.close();
      expect(closed).toBe(1);
    } finally { restore(); }
  });
});

describe("status bar wiring", () => {
  const counts = (overrides: Partial<ResultCounts> = {}): ResultCounts => ({ applied: 0, stale: 0, failed: 0, unresolved: 0, blocked: 0, partial: 0, conflict: 0, noop: 0, deferred: 0, ...overrides });

  /** The status bar item is Obsidian's element; the shim stands in for it. */
  function statusHarness(failure?: FailureClass) {
    const env = harness();
    env.plugin.statusBar = new FakeElement("div");
    let manual = 0;
    let opened = 0;
    env.plugin.scheduler.diagnostics = () => ({ lastFailureClass: failure });
    env.plugin.scheduler.requestReconcile = () => { manual += 1; };
    env.plugin.openConflictResolver = async () => { opened += 1; };
    return { env, host: env.plugin.statusBar, manual: () => manual, opened: () => opened };
  }

  it("shows a still, muted icon with no text while everything is in sync", () => {
    const { env, host } = statusHarness();
    env.plugin.setSchedulerStatus("idle", counts());
    expect(host.find((element) => element.classes.has("mineral-sync-status--idle"))).toBeDefined();
    expect(host.allText).toBe("");
    expect(host.find((element) => element.classes.has("is-spinning"))).toBeUndefined();
  });

  it("marks a running cycle with the spinning class and stops it afterwards", () => {
    const { env, host } = statusHarness();
    env.plugin.setSchedulerStatus("running", counts());
    expect(host.find((element) => element.classes.has("is-spinning"))).toBeDefined();

    env.plugin.setSchedulerStatus("idle", counts());
    expect(host.find((element) => element.classes.has("is-spinning"))).toBeUndefined();
  });

  it("advertises conflicts with a badge and the colour that means attention", () => {
    const { env, host } = statusHarness();
    env.plugin.lastConflictCount = 2;
    env.plugin.setSchedulerStatus("running", counts());
    expect(host.find((element) => element.classes.has("mineral-sync-status--conflict"))).toBeDefined();
    expect(host.allText).toBe("2");
    // Conflict outranks the running cycle, so the icon must not spin.
    expect(host.find((element) => element.classes.has("is-spinning"))).toBeUndefined();
  });

  it("opens the resolver on the first click when the status shows conflicts", () => {
    const { env, opened, manual } = statusHarness();
    env.plugin.lastConflictCount = 1;
    env.plugin.setSchedulerStatus("idle", counts());
    env.plugin.onStatusClick();
    expect(opened()).toBe(1);
    expect(manual()).toBe(0);
  });

  it("asks for a reconcile instead on every other status", () => {
    const { env, opened, manual } = statusHarness();
    env.plugin.setSchedulerStatus("debouncing", counts());
    env.plugin.onStatusClick();
    expect(manual()).toBe(1);
    expect(opened()).toBe(0);
  });

  it("reports an offline transport in red rather than as a conflict", () => {
    const { env, host } = statusHarness("retryable");
    env.plugin.setSchedulerStatus("idle", counts({ unresolved: 1 }));
    const root = host.find((element) => element.classes.has("mineral-sync-status--offline"));
    expect(root).toBeDefined();
    expect(root!.getAttribute("aria-label")).toContain("Offline");
    // Nothing readable in the bar itself: the state is carried by the colour.
    expect(host.visibleText).toBe("");
  });

  it("keeps the detail in the tooltip, and reachable from a right-click", () => {
    const { env, host } = statusHarness();
    env.plugin.lastConflictCount = 4;
    env.plugin.setSchedulerStatus("debouncing", counts());
    const root = host.find((element) => element.classes.has("mineral-sync-status"))!;
    expect(root.getAttribute("aria-label")).toContain("4 conflicts need attention");
    // The bar itself carries no sentence; the facts are one right-click away.
    expect(host.visibleText).toBe("4");

    // The stub records what was shown; `Notice` has no such static in the real types.
    const notices = Notice as unknown as { shown: string[] };
    notices.shown.length = 0;
    env.plugin.reportStatusDetails();
    expect(notices.shown.join("\n")).toContain("conflicts 4");
  });
});

/**
 * The three-level merge decision, as the plugin wires it.
 *
 * Level 0 and level 1 are settled by the divergence policy and must reach the user only as history;
 * level 2 is the only thing worth a badge. These tests pin that separation at the plugin boundary,
 * where the count, the resolver list and the Notice all come from, and pin the safety of the one write
 * the history viewer can cause.
 */

type FakeHistory = { entries: SyncHistoryEntry[]; record(entry: SyncHistoryEntry): Promise<void> };

interface HistoryInternals extends Internals {
  app: Internals["app"] & { vault: { getFileByPath(path: string): unknown; getAbstractFileByPath(path: string): unknown; createFolder(path: string): Promise<void>; modify(target: { path: string }, content: string): Promise<void>; create(path: string, content: string): Promise<void> } };
  resolvedChannel?: string;
  history: FakeHistory;
  coordinator?: { setChannel(channel: string): void; list(): Promise<ConflictRecord[]>; intentFor(path: string): Promise<ResolutionIntent | undefined>; clear(conflictId: string, path: string): Promise<void> };
  pendingConflicts(): Promise<ConflictRecord[]>;
  refreshConflictStatus(): Promise<void>;
  clearResolution(conflictId: string, path: string): Promise<void>;
  restoreFromHistory(input: { path: string; content: string; sourceHistoryId: string }): Promise<void>;
  openSyncHistory(): Promise<void>;
  openStatusMenu(event: MouseEvent): void;
  tombstoneCleanup: "waiting" | "ready" | "done";
  maybePruneTombstones(state: SchedulerState): void;
  pruneTombstones(): Promise<void>;
  conflictObservations(conflicts: Array<Extract<SyncOperation, { type: "conflict" }>>, local: Map<string, LocalEntry>, remote: Map<string, RemoteEntry>, previous: Map<string, PreviousEntry>): Array<Record<string, unknown>>;
}

const conflictRecord = (conflictId: string, status: AutoMergeStatus, extra: Partial<ConflictRecord> = {}): ConflictRecord => ({
  protocolVersion: CONFLICT_PROTOCOL_VERSION,
  conflictId,
  channel: "channel-1",
  path: "note.md",
  previous: { localVersion: { key: "note.md", size: 5, mtime: 100 }, remoteETag: "etag-base" },
  detectedAt: 1,
  autoMergeStatus: status,
  snapshot: { local: "local\n", remote: "remote\n", base: "base\n", baseAvailable: true },
  ...extra,
});

/** A plugin whose history, conflict store and Vault are all observable, with no real IndexedDB. */
function historyEnv(options: { file?: string | null } = {}) {
  const settings = { ...DEFAULT_SETTINGS, endpoint: "https://r2.example", bucket: "mineral" };
  const contents = new Map<string, string>();
  const file = options.file === null ? null : { path: "note.md" };
  if (file) contents.set("note.md", options.file ?? "current\n");

  const modified: Array<{ path: string; content: string }> = [];
  const created: Array<{ path: string; content: string }> = [];
  const marked: string[] = [];
  const reconciles: string[] = [];
  const stateWrites: unknown[] = [];
  const logs: string[] = [];

  const app = {
    vault: {
      getFileByPath: (path: string) => (file && path === file.path ? file : null),
      getAbstractFileByPath: () => null,
      createFolder: async () => {},
      read: async (target: { path: string }) => contents.get(target.path) ?? "",
      modify: async (target: { path: string }, content: string) => { contents.set(target.path, content); modified.push({ path: target.path, content }); },
      create: async (path: string, content: string) => { contents.set(path, content); created.push({ path, content }); },
    },
    workspace: { getLeavesOfType: () => [] },
  };

  const plugin = newPlugin(app) as unknown as HistoryInternals;
  plugin.app = app as unknown as HistoryInternals["app"];
  plugin.settings = settings;
  plugin.resolvedChannel = "channel-1";
  plugin.scheduler = {
    markLocalPaths: (paths: string[]) => { marked.push(...paths); return true; },
    refreshStatus: () => {},
    requestReconcile: (reason: string) => { reconciles.push(reason); },
  };
  // A state-store write here would mean a restore had moved the baseline, which is exactly what it must
  // never do: the baseline is what makes the next cycle compare the restored text as a local change.
  plugin.stateStore = { loadAll: async () => new Map(), saveVerified: async (entries: unknown) => { stateWrites.push(entries); } } as unknown as Internals["stateStore"];
  const history: FakeHistory = { entries: [], record: async (entry) => { history.entries.push(entry); } };
  plugin.history = history;
  (plugin as unknown as { debug(message: string): void }).debug = (message) => { logs.push(message); };

  const records: ConflictRecord[] = [];
  const intents = new Map<string, ResolutionIntent>();
  const cleared: string[] = [];
  plugin.coordinator = {
    setChannel: () => {},
    list: async () => records,
    intentFor: async (path) => intents.get(path),
    clear: async (conflictId) => { cleared.push(conflictId); },
  };

  return { plugin, history, records, intents, cleared, contents, modified, created, marked, reconciles, stateWrites, logs, settings };
}

describe("automatic merges stay out of the user's way", () => {
  beforeEach(() => { (Notice as unknown as { shown: string[] }).shown.length = 0; });

  it("reports a settled divergence as no work at all, and says nothing", async () => {
    const env = historyEnv();
    env.records.push(conflictRecord("auto-clean", "clean"), conflictRecord("auto-handoff", "handoff"));

    await env.plugin.refreshConflictStatus();

    // The badge counts decisions, and there are none: an automatic merge is not a conflict to the user.
    expect(env.plugin.lastConflictCount).toBe(0);
    expect(await env.plugin.pendingConflicts()).toEqual([]);
    expect((Notice as unknown as { shown: string[] }).shown).toEqual([]);
  });

  it("counts a conflict that needs a decision, and still does not interrupt", async () => {
    const env = historyEnv();
    env.records.push(conflictRecord("auto-clean", "clean"), conflictRecord("manual-1", "manual-required"), conflictRecord("auto-handoff", "handoff"));

    await env.plugin.refreshConflictStatus();

    expect(env.plugin.lastConflictCount).toBe(1);
    // The same filtered list is what the resolver is opened with, so this one assertion covers both the
    // badge and the queue the user is offered.
    expect((await env.plugin.pendingConflicts()).map((record) => record.conflictId)).toEqual(["manual-1"]);
    // The badge is the whole announcement; a Notice here is the interruption this behaviour removes.
    expect((Notice as unknown as { shown: string[] }).shown).toEqual([]);
  });
});

describe("history records what a resolution actually did", () => {
  it("records a manual resolution with both sides, the ancestor and what it replaced", async () => {
    const env = historyEnv();
    env.records.push(conflictRecord("manual-1", "manual-required", {
      reason: "overlapping edits",
      snapshot: { local: "mine\n", remote: "theirs\n", base: "base\n", draft: "draft\n", baseAvailable: true },
    }));
    env.intents.set("note.md", { protocolVersion: CONFLICT_PROTOCOL_VERSION, conflictId: "manual-1", channel: "channel-1", path: "note.md", type: "keep-local", createdAt: 2, origin: "manual" });

    await env.plugin.clearResolution("manual-1", "note.md");

    expect(env.history.entries).toHaveLength(1);
    const entry = env.history.entries[0]!;
    expect(entry.type).toBe("manual-conflict-resolved");
    expect(entry.path).toBe("note.md");
    // keep-local means the text this device already held is what landed.
    expect(entry.result.content).toBe("mine\n");
    expect(entry.base?.content).toBe("base\n");
    expect(entry.localBefore?.content).toBe("mine\n");
    expect(entry.remoteBefore?.content).toBe("theirs\n");
    expect(entry.metadata.resolutionType).toBe("keep-local");
    expect(entry.result.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The conflict is retired only after its evidence is written.
    expect(env.cleared).toEqual(["manual-1"]);
  });

  it("records a deletion the user accepted together with the content it removed", async () => {
    const env = historyEnv();
    env.records.push(conflictRecord("manual-delete", "manual-required", {
      reason: "remote logical deletion conflicts with a local modification",
      observedRemoteDeletion: { path: "note.md", deletedRemoteETag: "E", objectPresent: true },
      // The other device deleted it, so there is no remote content to record — only the local edit that
      // is about to be given up.
      snapshot: { local: "edited while away\n", base: "base\n", baseAvailable: true },
    }));
    env.intents.set("note.md", { protocolVersion: CONFLICT_PROTOCOL_VERSION, conflictId: "manual-delete", channel: "channel-1", path: "note.md", type: "accept-remote-delete", createdAt: 2, origin: "manual" });

    await env.plugin.clearResolution("manual-delete", "note.md");

    const entry = env.history.entries[0]!;
    expect(entry.type).toBe("manual-conflict-resolved");
    expect(entry.metadata.resolutionType).toBe("accept-remote-delete");
    // Accepting a deletion ends in no content at all, and that is recorded as such rather than papered
    // over. What makes the decision recoverable is the snapshot of what it removed.
    expect(entry.result.content).toBe("");
    expect(entry.localBefore?.content).toBe("edited while away\n");
    expect(entry.remoteBefore).toBeUndefined();
    // The direction is legible from the entry alone: the note was deleted remotely, not locally.
    expect(entry.base?.content).toBe("base\n");
  });

  it("records the note the user kept when a deletion was refused", async () => {
    const env = historyEnv();
    env.records.push(conflictRecord("manual-revive", "manual-required", {
      observedRemoteDeletion: { path: "note.md", deletedRemoteETag: "E", objectPresent: true },
      snapshot: { local: "kept\n", baseAvailable: true },
    }));
    env.intents.set("note.md", { protocolVersion: CONFLICT_PROTOCOL_VERSION, conflictId: "manual-revive", channel: "channel-1", path: "note.md", type: "keep-local", createdAt: 2, origin: "manual" });

    await env.plugin.clearResolution("manual-revive", "note.md");

    const entry = env.history.entries[0]!;
    // The revived text is the result, and the version it replaced is kept as the starting point: a
    // restore can put either side back.
    expect(entry.result.content).toBe("kept\n");
    expect(entry.localBefore?.content).toBe("kept\n");
    expect(entry.metadata.resolutionType).toBe("keep-local");
  });

  it("records an automatic handoff merge as a merge event, with the evidence behind it", async () => {
    const env = historyEnv();
    env.records.push(conflictRecord("auto-handoff", "handoff", {
      reason: "short device handoff",
      handoff: { reason: "short device handoff", branchSeparationMs: 3500, branchAgeMs: 900, localDeltaBytes: 13, remoteDeltaBytes: 5, hunkCount: 1, order: "stable-content" },
      snapshot: { local: "a\nlocal\n", remote: "a\nremote\n", base: "a\n", baseAvailable: true },
    }));
    env.intents.set("note.md", { protocolVersion: CONFLICT_PROTOCOL_VERSION, conflictId: "auto-handoff", channel: "channel-1", path: "note.md", type: "merged", createdAt: 2, origin: "auto", merged: { content: "merged\n", sha256: "x", encoding: { bom: false, eol: "lf", trailingNewline: true } } });

    await env.plugin.clearResolution("auto-handoff", "note.md");

    const entry = env.history.entries[0]!;
    expect(entry.type).toBe("handoff-auto-merge");
    // The merged bytes are the result, not either side: both additions were kept.
    expect(entry.result.content).toBe("merged\n");
    expect(entry.metadata).toMatchObject({ mergeReason: "short device handoff", branchSeparationMs: 3500, branchAgeMs: 900, localDeltaBytes: 13, remoteDeltaBytes: 5, hunkCount: 1, order: "stable-content" });
  });

  it("records nothing for a resolution that does not correspond to a record", async () => {
    const env = historyEnv();
    await env.plugin.clearResolution("gone", "note.md");

    // A stale intent is not evidence of anything that happened, so no entry claims it did.
    expect(env.history.entries).toEqual([]);
    expect(env.cleared).toEqual(["gone"]);
  });
});

/**
 * The seam where a Gateway delta becomes something the resolver can act on.
 *
 * A remote deletion has to arrive at the conflict record as a *deletion* — with the identity of the version
 * that was removed — because that is what selects the two decisions the resolver offers. Observed as a
 * plain absence instead, the same disagreement would be presented as a text problem with no buttons for it,
 * which is what this pins.
 */
describe("a Gateway delete reaches the resolver as a deletion", () => {
  it("carries the deleted version's identity into the conflict observation", async () => {
    const env = historyEnv();
    const client = {
      listObjects: async () => { throw new Error("a delta must never list objects"); },
      listTombstones: async () => { throw new Error("a delta must never list tombstones"); },
      headObject: async (key: string) => ({ key, size: 3, etag: "E", lastModified: 1_000 }),
      getObject: async () => { throw new Error("unused"); },
      putObject: async () => { throw new Error("a delta does not write"); },
    };
    const previousEntry: PreviousEntry = { key: "note.md", local: { size: 3, mtime: 10 }, remote: { size: 3, etag: "E" }, syncedAt: 1 };
    const observed = await observeRemoteDelta([{ op: "delete", path: "note.md" }], {
      client, ignores: () => false,
      loadPrevious: async () => new Map([["note.md", previousEntry]]),
      statLocal: async () => ({ size: 9, mtime: 42 }),
      acceptsBaseline: () => true,
    });

    const conflicts = env.plugin.conflictObservations(
      [{ type: "conflict", key: "note.md", conflict: "local-modified-remote-deleted", reason: "test" }],
      observed.local, observed.remote, observed.previous,
    );

    expect(conflicts).toEqual([{
      key: "note.md",
      previous: previousEntry,
      observedLocal: { key: "note.md", size: 9, mtime: 42 },
      observedRemoteDeletion: { path: "note.md", deletedRemoteETag: "E", objectPresent: true },
    }]);
    // Which is what makes the resolver offer "Keep note" and "Delete note" rather than a text editor.
    const record = { ...conflictRecord("manual-1", "manual-required"), ...conflicts[0]!, snapshot: { local: "kept\n", baseAvailable: true } } as ConflictRecord;
    expect(presentConflict(record).kind).toBe("delete-vs-modify");
  });
});

describe("tombstone retention is a once-per-session pass", () => {  /** The pass resolves a channel (a digest) and then talks to R2, so microtasks alone do not settle it. */
  const settle = async (): Promise<void> => { for (let index = 0; index < 8; index++) await new Promise((resolve) => setTimeout(resolve, 0)); await flush(); };

  it("waits for a reconciliation to finish, then runs exactly once", async () => {
    const env = historyEnv();
    const skipped = () => env.logs.filter((line) => line.startsWith("tombstone cleanup")).length;

    // A cycle that has not finished is not a moment to read (and possibly remove) remote metadata.
    env.plugin.maybePruneTombstones("debouncing");
    expect(env.plugin.tombstoneCleanup).toBe("waiting");
    env.plugin.maybePruneTombstones("running");
    expect(env.plugin.tombstoneCleanup).toBe("ready");
    expect(skipped()).toBe(0);

    env.plugin.maybePruneTombstones("idle");
    await settle();
    expect(env.plugin.tombstoneCleanup).toBe("done");
    // The pass runs, and a failure inside it stays a debug line: retention is housekeeping, not sync.
    expect(skipped()).toBe(1);

    // Every later cycle is ignored, because the window is measured in weeks.
    env.plugin.maybePruneTombstones("running");
    env.plugin.maybePruneTombstones("idle");
    await settle();
    expect(env.plugin.tombstoneCleanup).toBe("done");
    expect(skipped()).toBe(1);
  });

  it("does not reach the network without a configured namespace", async () => {
    const env = historyEnv();
    env.plugin.settings = { ...env.settings, endpoint: "", bucket: "" };

    await env.plugin.pruneTombstones();

    expect(env.logs.filter((line) => line.startsWith("tombstone cleanup"))).toEqual([]);
  });
});

describe("restoring an earlier version", () => {
  it("writes the snapshot locally and leaves the decision to normal sync", async () => {
    const env = historyEnv({ file: "current\n" });

    await env.plugin.restoreFromHistory({ path: "note.md", content: "older\n", sourceHistoryId: "h1" });

    expect(env.modified).toEqual([{ path: "note.md", content: "older\n" }]);
    expect(env.contents.get("note.md")).toBe("older\n");
    expect(env.marked).toEqual(["note.md"]);
    expect(env.reconciles).toEqual(["manual"]);

    const entry = env.history.entries[0]!;
    expect(entry.type).toBe("restore");
    expect(entry.result.content).toBe("older\n");
    // What was current before is kept, so the restore is itself undoable.
    expect(entry.previousCurrent?.content).toBe("current\n");
    expect(entry.metadata.sourceHistoryId).toBe("h1");

    // No baseline write and no direct transfer: the restored text must be seen as an ordinary local
    // edit, which is what makes a remote that moved in the meantime a conflict instead of an overwrite.
    expect(env.stateWrites).toEqual([]);
  });

  it("recreates a file that no longer exists", async () => {
    const env = historyEnv({ file: null });
    await env.plugin.restoreFromHistory({ path: "note.md", content: "older\n", sourceHistoryId: "h1" });

    expect(env.created).toEqual([{ path: "note.md", content: "older\n" }]);
    expect(env.modified).toEqual([]);
    expect(env.history.entries[0]?.type).toBe("restore");
  });

  it("claims nothing when the write fails", async () => {
    const env = historyEnv({ file: "current\n" });
    env.plugin.app.vault.modify = async () => { throw new Error("vault is read-only"); };

    await expect(env.plugin.restoreFromHistory({ path: "note.md", content: "older\n", sourceHistoryId: "h1" })).rejects.toThrow("read-only");

    // Recorded after the write, so a failed restore leaves no entry saying it happened.
    expect(env.history.entries).toEqual([]);
    expect(env.reconciles).toEqual([]);
  });

  it("refuses to open history without a configured namespace", async () => {
    const env = historyEnv();
    env.plugin.resolvedChannel = undefined;
    env.plugin.settings = { ...env.settings, endpoint: "", bucket: "" };
    (Notice as unknown as { shown: string[] }).shown.length = 0;

    await env.plugin.openSyncHistory();

    expect((Notice as unknown as { shown: string[] }).shown.join("\n")).toContain("sync history needs");
  });

  it("is reachable from the status bar's secondary click", async () => {
    const env = historyEnv();
    let opened = 0;
    env.plugin.openSyncHistory = async () => { opened += 1; };
    const menus = Menu as unknown as { shown: Array<{ items: Array<{ title: string; callback: () => void }> }> };
    menus.shown.length = 0;

    env.plugin.openStatusMenu({ preventDefault: () => {} } as unknown as MouseEvent);

    const items = menus.shown[menus.shown.length - 1]!.items;
    expect(items.map((item) => item.title)).toEqual(["Sync history", "Status details"]);
    items[0]!.callback();
    expect(opened).toBe(1);
  });
});





