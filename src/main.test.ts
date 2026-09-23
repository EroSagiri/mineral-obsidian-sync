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

describe("status bar wiring", () => {
  const counts = (overrides: Partial<ResultCounts> = {}): ResultCounts => ({ applied: 0, stale: 0, failed: 0, unresolved: 0, blocked: 0, partial: 0, conflict: 0, noop: 0, ...overrides });

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
