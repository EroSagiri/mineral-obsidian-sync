import { MarkdownView, Menu, Notice, Platform, Plugin, TFile, TFolder } from "obsidian";
import { scanLocal, scanLocalAdapterMetadata } from "./local/scan-local";
import { readStableLocalBytes } from "./local/read-local";
import { flushAction, isOwnWrite, writeChangedFile, type FileStamp } from "./local/android-editor-save";
import { remoteIdentity, SignedR2ListClient } from "./remote/r2-client";
import { scanRemote } from "./remote/scan-remote";
import { pruneExpiredTombstones, protectedFromCleanup } from "./remote/tombstone-retention";
import { DEFAULT_SETTINGS, R2SyncSettingTab, type R2SyncSettings } from "./settings";
import { IndexedDbStateStore } from "./state/state-store";
import { buildBootstrapResult } from "./bootstrap/bootstrap";
import { DryRunModal } from "./ui/dry-run-modal";
import { createVaultPathFilter, ignorePolicyFingerprint } from "./sync/ignore";
import { registerDevelopmentSelfTests } from "./dev/self-test-command";
import { SafeExecutor, type VaultFileRemover } from "./sync/executor";
import { pathDigest } from "./sync/path";
import { buildSyncPlan } from "./sync/planner";
import { observeLocalDelta, observeRemoteDelta } from "./sync/remote-delta";
import { localChanged } from "./sync/fingerprint";
import { SyncScheduler } from "./scheduler/scheduler";
import { changedLocalKeys } from "./scheduler/mobile-local-drift";
import { GatewayClient, type GatewayClientDiagnostics } from "./gateway/client";
import { createMutationIngressReporter, type MutationIngressReporter } from "./gateway/mutation-ingress";
import { RequestUrlGatewayTransport } from "./gateway/transport";
import { IndexedDbGatewayCursorStore } from "./gateway/cursor-store";
import { resolveGatewayConfig } from "./gateway/config";
import type { GatewayConfigState } from "./gateway/types";
import { gatewayConnectionConfig } from "./gateway/types";
import { deriveRemoteChangeChannel } from "@mineral/sync-core/channel";
import type { RemoteChange } from "@mineral/sync-core/sync-change";
import { IndexedDbConflictStores } from "./conflict/stores";
import { createMergeBaseRecorder, recordMergeBaseBatch, type MergeBaseInput } from "./conflict/merge-base";
import { ConflictCoordinator } from "./conflict/coordinator";
import { isAutoResolved, type ConflictRecord, type HandoffEvidence, type ResolutionIntent } from "./conflict/types";
import { ConflictResolverModal } from "./ui/conflict-resolver-modal";
import { CONFLICT_RESOLVER_CSS } from "./ui/conflict-styles";
import { ensureParentFolders } from "./local/ensure-folders";
import { mergeHistoryEntry, manualHistoryEntry, restoreHistoryEntry, snapshotOf } from "./history/entry";
import { IndexedDbSyncHistoryStore } from "./history/store";
import type { SyncHistoryMetadata, SyncHistoryStore } from "./history/types";
import { SyncHistoryModal } from "./ui/sync-history-modal";
import { SYNC_HISTORY_CSS } from "./ui/history-styles";
import { HotConflictModal } from "./ui/hot-conflict-modal";
import { presentSyncStatus, renderSyncStatus, SYNC_STATUS_CSS, SYNC_STATUS_ICON, type HotStatusInput, type SyncStatusPresentation } from "./ui/sync-status";
import { isRemoteDeleted, type LocalEntry, type PreviousEntry, type RemoteEntry, type RemoteIdentity, type SyncOperation } from "./sync/types";
import type { ConflictObservation, ResultCounts, SchedulerState } from "./scheduler/types";
import { HotGatewayClient, type HotHttpRequest, type HotHttpResponse, type HotSocket } from "./hot/client";
import { HotSyncCoordinator } from "./hot/coordinator";
import { IndexedDbHotStateStore } from "./hot/store";
import type { HotBaseline } from "./hot/types";
import { hotContentHash } from "@mineral/sync-core/hot-protocol";

type CycleObservations = { local: Map<string, LocalEntry>; remote: Map<string, RemoteEntry>; previous: Map<string, PreviousEntry> };

const ANDROID_LOCAL_DRIFT_INTERVAL_MS = 15_000;
const ANDROID_EDITOR_SAVE_DEBOUNCE_MS = 500;
/** How long a buffer snapshot is kept for content-based external-edit identification. */
const HOT_BUFFER_SNAPSHOT_RETENTION_MS = 60_000;
/** Hard cap on the snapshot count per path so an idle session cannot grow unbounded memory. */
const HOT_BUFFER_SNAPSHOT_MAX = 32;
const INTEGRITY_RECONCILE_TICK_MS = 60_000;
/**
 * Above this many drifted paths the drift is reported as it stands, without consulting the baseline:
 * a bulk change is never this plugin's own download, and one IndexedDB read per path would be waste.
 */
const ANDROID_DRIFT_BASELINE_LIMIT = 25;
/** A markdown note this large is not an editing surface worth re-reading on every drift tick. */
const ANDROID_BUFFER_COMPARISON_MAX_BYTES = 2_000_000;
/** The all-zero result counts a scheduler reports before its first cycle. */
const NO_RESULTS: ResultCounts = { applied: 0, stale: 0, failed: 0, unresolved: 0, blocked: 0, partial: 0, conflict: 0, noop: 0, deferred: 0 };
/**
 * How many operation frames may wait for a WebSocket handshake.
 *
 * Far more than any handshake needs, and small enough that a connection which never completes cannot
 * grow an array for the life of the session.
 */
const MAX_QUEUED_HOT_FRAMES = 64;

export default class R2PersonalSyncPlugin extends Plugin {
  settings: R2SyncSettings = { ...DEFAULT_SETTINGS };
  private readonly stateStore = new IndexedDbStateStore();
  private readonly gatewayCursors = new IndexedDbGatewayCursorStore();
  private readonly conflictStores = new IndexedDbConflictStores();
  private activeAnalysis?: AbortController;
  private statusBar?: HTMLElement;
  /** The last presentation applied, so a click can act on exactly what the user is looking at. */
  private statusPresentation?: SyncStatusPresentation;
  private scheduler?: SyncScheduler;
  private gateway?: GatewayClient;
  private coordinator?: ConflictCoordinator;
  /**
   * The hot layer, once it is configured and restored.
   *
   * It is created lazily and only when the user asked for it: with hot sync off, this plugin behaves
   * exactly as it did before the feature existed.
   */
  private hotCoordinator?: HotSyncCoordinator;
  private readonly hotStore = new IndexedDbHotStateStore();
  /** The one path this device currently holds open hot, if any. */
  private hotOpenPath?: string;
  /**
   * File-open events are not a document lifecycle by themselves: Obsidian can emit the next one while
   * the previous hot acquire is still waiting on HTTP/WebSocket state, and it may reuse the same Editor
   * object for the new file. Serialize those transitions and invalidate the older request immediately.
   * Without both halves, an old room can attach to the editor now showing a different note and project
   * its remote text into that note.
   */
  private hotDocumentTransition: Promise<void> = Promise.resolve();
  private hotDocumentRequest = 0;
  private hotLastError?: string;
  /** Development only: the recent debug lines, so a device can report its own reasoning. */
  private readonly debugRing: string[] = [];
  /** The last disk content this plugin observed per hot path, so an unchanged file never looks external. */
  private readonly hotDiskText = new Map<string, string>();
  /**
   * Recent buffer snapshots per hot path, kept briefly so a vault event that lands before the latest
   * keystroke is still recognised as our own autosave rather than as a write from someone else.
   *
   * The old rule was a 5 second time window; a delayed autosave could exceed it (false positive) and a
   * true external write inside it would be swallowed (false negative). Matching on the content identity
   * of what this plugin last wrote removes both without picking a magic number.
   */
  private readonly hotRecentBuffers = new Map<string, { text: string; at: number }[]>();
  private gatewayConfig: GatewayConfigState = { kind: "disabled" };
  private androidLocalSnapshot?: Map<string, LocalEntry>;
  private androidLocalDriftPollRunning = false;
  /** One quiet-period save per edited path; Android can otherwise defer Vault modify until view close. */
  private readonly androidEditorSaveTimers = new Map<string, number>();
  /**
   * Paths whose editor buffer may not be on disk yet.
   *
   * Membership is the plugin's only record that a buffer is owed, and it is load-bearing: every other
   * trigger the plugin has reads the *file*, which by definition has not been written. A path therefore
   * stays here until a save succeeds or no view holds it any more, so a save that cannot run now is
   * retried instead of being lost.
   */
  private readonly androidPendingEditorSaves = new Set<string>();
  /** Paths with a save in flight, so an armed timer and a drift tick cannot write one buffer twice. */
  private readonly androidEditorSavesInFlight = new Set<string>();
  /** The version this plugin's own editor saves produced, so their Vault event is not double-reported. */
  private readonly androidEditorWriteStamps = new Map<string, FileStamp>();
  /**
   * Local, best-effort record of what sync did to each file.
   *
   * Never read on the sync path — the plan is unaffected by whether history exists — so it is the one
   * store this plugin can lose without changing behaviour. It is what makes automatic merges reviewable
   * after the fact, which is the trade the automation depends on.
   */
  private readonly history: SyncHistoryStore = new IndexedDbSyncHistoryStore();
  private lastConflictCount = 0;
  /** Retention is a once-per-session pass, held back until a reconciliation has finished. */
  private tombstoneCleanup: "waiting" | "ready" | "done" = "waiting";
  /**
   * The mutation journal, as this device writes to it.
   *
   * It is configured once and reads the live settings on every report, so toggling it or fixing a token
   * takes effect on the next cycle without rebuilding the scheduler.
   */
  private readonly mutationIngress: MutationIngressReporter = createMutationIngressReporter({
    settings: () => ({
      // The report is sent to the Gateway, over the channel this device derived for its own R2
      // namespace. There is no Vault address and no ingress secret to configure.
      enabled: Boolean(this.settings.mutationIngressEnabled),
      gatewayEndpoint: this.settings.gatewayEndpoint,
      gatewayToken: this.settings.gatewayToken,
      channel: this.currentChannel(),
    }),
    transport: new RequestUrlGatewayTransport(),
    now: () => Date.now(),
    debug: (message) => this.debug(message),
  });
  /** The derived channel for the current settings, refreshed once per cycle. */
  private resolvedChannel?: string;
  private lastIntegrityRequestedAt = 0;

  async onload(): Promise<void> {
    const persisted = (await this.loadData() ?? {}) as Partial<R2SyncSettings> & { ignoredFolders?: unknown; ignoredFiles?: unknown };
    const { ignoredFolders, ignoredFiles, ...current } = persisted;
    const legacyPaths = [
      ...(Array.isArray(ignoredFolders) ? ignoredFolders : []),
      ...(Array.isArray(ignoredFiles) ? ignoredFiles : []),
    ].filter((value): value is string => typeof value === "string");
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...current,
      ignoredPaths: Array.isArray(persisted.ignoredPaths) ? persisted.ignoredPaths.filter((value): value is string => typeof value === "string") : legacyPaths,
    };
    this.addSettingTab(new R2SyncSettingTab(this.app, this));
    this.addCommand({ id: "r2-sync-inspect-state", name: "Mineral Sync: Inspect Sync State", callback: () => this.inspectSyncState() });
    this.addCommand({ id: "r2-sync-test-connection", name: "R2 Sync: Test Connection", callback: () => this.testConnection() });
    this.addCommand({ id: "r2-sync-now", name: "Mineral Sync: Sync Now", callback: () => this.scheduler?.requestReconcile("manual") });
    this.addCommand({ id: "r2-sync-gateway-status", name: "Mineral Sync: Gateway Status", callback: () => this.reportGatewayStatus() });
    this.addCommand({ id: "r2-sync-resolve-conflicts", name: "Mineral Sync: Resolve Conflicts", callback: () => this.openConflictResolver() });
    this.addCommand({ id: "r2-sync-resolve-hot-conflicts", name: "Mineral Sync: Resolve Hot Sync Conflicts", callback: () => this.openHotConflictResolver() });
    this.addCommand({ id: "r2-sync-history", name: "Mineral Sync: Open Sync History", callback: () => this.openSyncHistory() });
    // Development-only diagnostics: never registered, and not even bundled, in production.
    if (__DEV__) {
      registerDevelopmentSelfTests({
        app: this.app,
        settings: this.settings,
        pluginDir: this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
        addCommand: (command) => this.addCommand(command),
        setStatus: (text) => this.showBusyStatus(text),
        // The hot self-test observes the *live* coordinator, which is what makes its wiring scenario a
        // test of this plugin's event handling rather than of a copy of it.
        hot: {
          enabled: () => Boolean(this.settings.hotSyncEnabled && this.settings.gatewayEnabled),
          coordinator: () => this.hotCoordinator,
          refresh: () => this.refreshHotSync(),
          statusText: () => this.hotSyncStatusText(),
        },
      });
    }
    // Theme-variable CSS for the status glyph, the resolver and the history viewer, injected rather than
    // shipped as a second file, so the deployment surface stays exactly `main.js` + `manifest.json`.
    const statusStyle = document.head.createEl("style", { text: `${SYNC_STATUS_CSS}\n${CONFLICT_RESOLVER_CSS}\n${SYNC_HISTORY_CSS}` });
    this.register(() => statusStyle.remove());
    this.statusBar = this.addStatusBarItem();
    // Attached once, to the item itself, because its inner content is rebuilt on every state change.
    // A conflict click goes straight to the resolver: never a menu the user has to click through.
    this.registerDomEvent(this.statusBar, "click", () => this.onStatusClick());
    this.registerDomEvent(this.statusBar, "contextmenu", (event) => { event.preventDefault(); this.openStatusMenu(event); });
    this.renderStatus(presentSyncStatus({ state: "idle", counts: NO_RESULTS, conflictCount: 0 }));
    this.gateway = new GatewayClient(
      () => gatewayConnectionConfig(this.settings),
      new RequestUrlGatewayTransport(),
      this.gatewayCursors,
      {
        // A Gateway announcement is only ever a reason to reconcile. It carries no path, no
        // operation, and no instruction; the planner still decides everything.
        onAnnounced: (generation, source, changes) => {
          this.debug(`gateway event remoteGeneration=${generation} lastAppliedGeneration=${this.gateway?.lastReconciled() ?? "0"} source=${source} changes=${changes?.length ?? 0}`);
          this.scheduler?.requestRemoteChange(generation, changes);
        },
        onStatusChanged: () => this.scheduler?.refreshStatus(),
      },
      { openSocket: (url) => new WebSocket(url), now: () => Date.now(), timerSet: (delay, callback) => window.setTimeout(callback, delay), timerClear: (handle) => window.clearTimeout(handle as number), debug: (message) => this.debug(message) },
    );
    this.coordinator = new ConflictCoordinator({
      vault: this.app.vault,
      client: new SignedR2ListClient(this.settings),
      // A per-call channel: the coordinator must follow a namespace change, and every record it writes
      // is keyed by channel so an intent can never cross namespaces.
      channel: this.currentChannel() ?? "",
      mergeBase: this.conflictStores,
      conflicts: this.conflictStores,
      intents: this.conflictStores,
      requestReconcile: (reason) => this.scheduler?.requestReconcile(reason),
      debug: (message) => this.debug(message),
    });
    this.scheduler = new SyncScheduler({
      visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
      captureCycle: () => this.captureSchedulerCycle(),
      onStatus: (state, counts) => this.setSchedulerStatus(state, counts),
      debug: (message) => this.debug(message),
      onConflicts: (conflicts) => this.handleConflicts(conflicts),
      // A second control-plane port, for the service that owns the *facts* rather than the wake-up. It is
      // handed only what this device observed a write to leave in R2, and its answer is never read: the
      // write is durable before this runs, so a report can only defer, never fail or reclassify.
      mutationIngress: {
        report: (changes) => this.mutationIngress.report(changes),
        // One writer, one announcer: a configured ingress makes the journal the only source of gateway
        // generations for this device's writes, so the scheduler stops sending its own `/dirty`.
        announcesLandedWrites: () => this.mutationIngress.announcesLandedWrites(),
      },
      onResolutionApplied: (conflictId, path) => this.clearResolution(conflictId, path),
      // The hot fence, asked at the mutation boundary rather than at plan time.
      hotDeferral: {
        isFenced: (key) => this.hotCoordinator?.isFenced(key) ?? false,
        noteDeferred: (key) => this.hotCoordinator?.noteDeferred(key),
      },
      // The cross-device half: only the Gateway knows whether another device is editing this path now.
      hotAuthority: {
        authorize: (key) => this.hotCoordinator?.authorizeColdMutation(key) ?? Promise.resolve("granted" as const),
        settle: async (key) => { await this.hotCoordinator?.settleColdMutation(key); },
      },
      remoteChange: {
        hasPending: () => this.gateway?.hasPending() ?? false,
        readGeneration: () => this.gateway?.readGeneration() ?? Promise.resolve({ ok: false as const, kind: "misconfigured" }),
        confirmReconciled: async (generation) => { await this.gateway?.confirmReconciled(generation); },
        notifyRemoteDirty: (changes) => this.gateway?.markRemoteDirty(changes) ?? Promise.resolve({ ok: false as const, kind: "misconfigured" }),
        canApplyIncrementally: (generation) => this.gateway?.canApplyIncrementally(generation) ?? false,
      },
    });
    this.app.workspace.onLayoutReady(() => {
      this.registerVaultListeners();
      this.registerAndroidLocalDriftDetector();
      this.registerInterval(window.setInterval(() => this.maybeRequestIntegrityReconcile(), INTEGRITY_RECONCILE_TICK_MS));
      this.registerDomEvent(document, "visibilitychange", () => this.onVisibilityChanged(document.visibilityState !== "hidden"));
      // The channel is a digest, so it is resolved once before the first cycle, which is what lets the
      // planner receive valid resolution intents synchronously instead of doing its own I/O.
      void this.resolveChannel().then(() => { this.lastIntegrityRequestedAt = Date.now(); this.scheduler?.requestReconcile("startup"); });
      void this.applyGatewayConfig(true);
      // The hot layer has to adopt the file the user is already looking at. Waiting for a `file-open`
      // event is what made the feature look broken: enabling it (or loading the plugin) produces no such
      // event, so the note in front of the user stayed cold while the status bar said hot sync was on.
      void this.refreshHotSync().then(() => this.openActiveFileHot());
    });
  }

  onunload(): void {
    this.activeAnalysis?.abort();
    // Best effort: an owed buffer is written before the timers that could still carry it go away.
    // Obsidian also saves on the way out, so this is a belt-and-braces step rather than the only one.
    void this.flushPendingAndroidEditorSaves("unload", true);
    this.scheduler?.stop();
    for (const handle of this.androidEditorSaveTimers.values()) window.clearTimeout(handle);
    this.androidEditorSaveTimers.clear();
    // Closing the socket and cancelling reconnect timers happens before any further work can start.
    this.hotCoordinator?.shutdown();
    this.hotCoordinator = undefined;
    this.hotOpenPath = undefined;
    this.gateway?.stop();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.scheduler?.configChanged();
    // A settings save can change the channel, the endpoint, or the token; all three must reconnect,
    // and the channel cursor is reloaded before any new socket can deliver a generation.
    await this.applyGatewayConfig(false);
    await this.refreshHotSync();
  }

  /* ------------------------------------------------------------------------------------------------
   * Hot (realtime) collaboration
   *
   * The hot layer is opt-in and self-contained: with it off, nothing below runs and the plugin behaves
   * exactly as it did before the feature existed. With it on, an open Markdown file is owned by a
   * server-side room, and the cold path is fenced for that path until a verified handoff completes.
   * ---------------------------------------------------------------------------------------------- */

  /** Starts, stops, or leaves the hot layer alone according to the current settings. */
  async refreshHotSync(): Promise<void> {
    const wanted = Boolean(this.settings.hotSyncEnabled && this.settings.gatewayEnabled);
    if (!wanted) {
      // Turning it off must finish the handoff for anything still open, not abandon it mid-session.
      const coordinator = this.hotCoordinator;
      await this.closeHotDocument();
      // A handoff may legitimately stay pending when the network is down. The durable record keeps
      // that debt, but the disabled plugin instance must never leave its raw socket or reconnect loop
      // alive: a later enable would otherwise create a second socket with the same client identity.
      coordinator?.shutdown();
      this.hotCoordinator = undefined;
      this.hotOpenPath = undefined;
      this.scheduler?.refreshStatus();
      return;
    }
    if (this.hotCoordinator) return;
    if (!this.settings.gatewayEndpoint.trim() || !this.settings.gatewayToken) {
      this.hotLastError = "Gateway endpoint or token missing";
      this.scheduler?.refreshStatus();
      return;
    }
    try {
      const identity = remoteIdentity(this.settings);
      const channel = await deriveRemoteChangeChannel({ endpoint: identity.endpoint, bucket: identity.bucket, remotePrefix: identity.remotePrefix });
      const transport = new RequestUrlGatewayTransport();
      const token = this.settings.gatewayToken;
      const client = new HotGatewayClient(
        { endpoint: this.settings.gatewayEndpoint.trim(), token, channel },
        (request: HotHttpRequest): Promise<HotHttpResponse> => transport.send({ ...request, token }),
        (url) => this.openHotSocket(url),
      );
      const coordinator = new HotSyncCoordinator({
        client,
        store: this.hotStore,
        clientId: await this.ensureHotClientId(),
        commitBaseline: (path, baseline) => this.commitHotBaseline(path, baseline),
        onStatus: (path, status, detail) => this.debug(`hot status path-digest=${pathDigest(path)} status=${status}${detail ? ` detail=${detail}` : ""}`),
        onConflict: (path, reason) => {
          this.debug(`hot conflict path-digest=${pathDigest(path)} reason=${reason}`);
          new Notice(`Mineral Sync：${path} 的热同步进入冲突状态（${reason}），冷同步已暂停该路径，内容未被覆盖。点击状态栏可决定保留哪一份。`);
          this.scheduler?.refreshStatus();
        },
        // A resolution needs the *disk* bytes: for an external edit that is the version this device did
        // not write, and it is the one thing the coordinator cannot read for itself.
        readLocalText: async (path) => {
          try { return await this.app.vault.adapter.read(path); }
          catch { return undefined; }
        },
        // A resolution that makes the file adopt the server's version has to actually write the file, not
        // only the pane: the pane may not exist and the disk is what sync is about.
        writeLocalText: async (path, text) => {
          try { await this.app.vault.adapter.write(path, text); }
          catch (error) { this.debug(`hot write-back failed path-digest=${pathDigest(path)} error=${error instanceof Error ? error.message : "unknown"}`); }
        },
        // A hot session writes into the buffer whenever a remote edit lands, and any write moves the
        // viewport. The pane's place is captured first and put back afterwards, so a syncing note does not
        // drag the reader's view around — the complaint this exists for.
        preserveViewport: (path) => this.preserveViewportFor(path),
        onResolved: (path, decision) => {
          this.debug(`hot resolved path-digest=${pathDigest(path)} decision=${decision}`);
          // Whatever was decided, the cold path has to look at the file again: either to publish the
          // version that won, or to reconcile the local file against whatever R2 holds.
          this.scheduler?.requestReconcile("hot-resolution");
        },
        debug: (message) => this.debug(message),
      });
      const restored = await coordinator.restore();
      this.hotCoordinator = coordinator;
      this.hotLastError = undefined;
      this.debug(`hot ready channel=${channel.slice(0, 6)}… sessions=${restored.sessions.length} handoffs=${restored.handoffs}`);
      if (restored.handoffs > 0) new Notice(`Mineral Sync：${restored.handoffs} 个文件的交接尚未完成，将在打开时继续。`);
      // Enabling the feature is itself a reason to take the current document hot: the user just asked for
      // it, and the file they are looking at is the one they mean.
      this.openActiveFileHot();
      void this.forgetMissingHotPaths();
    } catch (error) {
      this.hotLastError = error instanceof Error ? error.message : "unknown error";
      this.debug(`hot unavailable: ${this.hotLastError}`);
    }
    this.scheduler?.refreshStatus();
  }

  /**
   * Takes the document the user is already looking at hot.
   *
   * The plugin otherwise only reacts to `file-open`, which means the file that was open *before* hot sync
   * became available never became hot at all — the feature looked broken while it was working exactly as
   * written. Called when the layer appears and once the workspace layout is ready.
   */
  private openActiveFileHot(): void {
    if (!this.hotCoordinator) return;
    const file = this.app.workspace.getActiveFile();
    if (file && file.extension === "md") void this.openHotDocument(file);
  }

  /**
   * Captures a pane's scroll position, returning the restore.
   *
   * `currentMode` covers both the source editor and the reading view, and both expose the scroll pair; the
   * guard is there because a pane can be mid-transition when a remote edit lands, and losing a scroll
   * restore must never break the sync itself.
   */
  private preserveViewportFor(path: string): (() => void) | undefined {
    const mode = this.markdownViewFor(path)?.currentMode;
    if (!mode || typeof mode.getScroll !== "function" || typeof mode.applyScroll !== "function") return undefined;
    let scroll: number;
    try { scroll = mode.getScroll(); }
    catch { return undefined; }
    return () => {
      try { mode.applyScroll(scroll); }
      catch { /* the pane moved on; a stale scroll is not worth an error */ }
    };
  }

  /**
   * Drops hot records whose file is no longer in the vault.
   *
   * A conflict or a pending handoff about a path with no file cannot be answered and cannot be delivered:
   * it fences nothing real and it sits in front of the user forever. Deleting the file ends it.
   */
  private async forgetMissingHotPaths(): Promise<void> {
    const coordinator = this.hotCoordinator;
    if (!coordinator) return;
    const missing = [...coordinator.hotConflicts().map(entry => entry.canonicalPath)];
    for (const path of missing) {
      if (this.app.vault.getAbstractFileByPath(path)) continue;
      this.debug(`hot forget path-digest=${pathDigest(path)} reason=file-is-gone`);
      await coordinator.forget(path).catch(() => undefined);
    }
    this.scheduler?.refreshStatus();
  }

  /** A stable per-device id, minted once and persisted: the server scopes operation dedupe to it. */
  private async ensureHotClientId(): Promise<string> {
    if (!this.settings.hotClientId) {
      this.settings.hotClientId = crypto.randomUUID();
      await this.saveData(this.settings);
    }
    return this.settings.hotClientId;
  }

  /**
   * The platform's WebSocket, adapted to the shape the session knows.
   *
   * The one thing this adapter must not do is hand the session the browser's `send` semantics: a
   * WebSocket that is still connecting throws instead of buffering, and a session may legitimately
   * produce a frame before the handshake finishes — the outbox drains on its own timer, and the first
   * content push happens as soon as `open()` returns. On a desktop that window is a few milliseconds; on
   * a phone on mobile data it is not, which is why the frames are held here rather than lost there.
   *
   * If the handshake never completes, the queue is abandoned and the socket closed: every frame in it is
   * still owed by the durable outbox, which is what re-sends unacknowledged work after a reconnect.
   */
  private openHotSocket(url: string): HotSocket {
    const socket = new WebSocket(url);
    const queued: string[] = [];
    let open = false;
    socket.addEventListener("open", () => {
      open = true;
      for (const frame of queued.splice(0)) socket.send(frame);
    });
    return {
      send: (data) => {
        if (open) { socket.send(data); return; }
        if (queued.length >= MAX_QUEUED_HOT_FRAMES) {
          // A handshake that never finishes is a dead connection, not a reason to grow this array.
          try { socket.close(); } catch { /* already closing */ }
          return;
        }
        queued.push(data);
      },
      close: (code, reason) => socket.close(code, reason),
      onMessage: (handler) => socket.addEventListener("message", (event) => handler(String(event.data))),
      onClose: (handler) => socket.addEventListener("close", () => handler()),
    };
  }

  /** Opens the hot session for the file the user just brought into focus. */
  private openHotDocument(file: TFile): Promise<void> {
    const request = ++this.hotDocumentRequest;
    const transition = this.hotDocumentTransition
      .catch(() => undefined)
      .then(() => this.openHotDocumentNow(file, request));
    this.hotDocumentTransition = transition;
    return transition;
  }

  /** Performs one serialized file transition, provided no newer file-open request superseded it. */
  private async openHotDocumentNow(file: TFile, request: number): Promise<void> {
    const coordinator = this.hotCoordinator;
    if (request !== this.hotDocumentRequest || !coordinator) return;
    // The latest file-open is also a close request when the new target cannot be hot. Leaving the previous
    // Markdown binding alive here is especially dangerous for ignored notes because Obsidian may reuse its
    // Editor object for the ignored file.
    if (file.extension !== "md") {
      await this.closeHotDocumentNow();
      return;
    }
    // Resolve the pane *before* giving up the current session. A file-open event can arrive for a file
    // whose view is not the active one yet — mobile fires these more freely than desktop does — and
    // closing first turned a spurious event into "the document I was editing quietly stopped being hot".
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== file.path) return;
    if (createVaultPathFilter(this.settings).ignores(file.path)) {
      await this.closeHotDocumentNow();
      return;
    }
    if (this.hotOpenPath === file.path) {
      // The file is already hot, but the *pane* may have been rebuilt since (restoring the workspace,
      // switching modes, moving the tab), and the session would then be observing an editor nobody types
      // into: owned on the server, and completely silent. Point it at the editor that is on screen.
      coordinator.rebind(file.path, view.editor);
      return;
    }
    await this.closeHotDocumentNow();
    if (request !== this.hotDocumentRequest || this.hotCoordinator !== coordinator) return;
    try {
      // The editor is the right source when the user has been typing, but a mobile pane can still be
      // showing an unloaded buffer when `file-open` fires. The file is the truth then, and taking it
      // matters: a session seeded with nothing would leave the note with no revision at all until
      // somebody happened to type into it.
      const currentView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!currentView || currentView.file?.path !== file.path) return;
      const editor = currentView.editor;
      let localText = editor.getValue();
      if (localText.length === 0) {
        try { localText = await this.app.vault.read(file); }
        catch { /* an unreadable file leaves the session to adopt content later */ }
      }
      if (request !== this.hotDocumentRequest || this.hotCoordinator !== coordinator) return;
      const isCurrent = () => {
        if (request !== this.hotDocumentRequest || this.hotCoordinator !== coordinator) return false;
        const active = this.app.workspace.getActiveViewOfType(MarkdownView);
        return active?.file?.path === file.path && active.editor === editor;
      };
      const outcome = await coordinator.open({ canonicalPath: file.path, editor, localText, isCurrent });
      if (!isCurrent()) return;
      if (outcome.outcome === "hot") {
        this.hotOpenPath = file.path;
        this.debug(`hot opened path-digest=${pathDigest(file.path)} epoch=${outcome.identity?.epoch ?? 0}`);
      } else {
        this.debug(`hot not opened path-digest=${pathDigest(file.path)} outcome=${outcome.outcome} reason=${outcome.reason ?? "n/a"}`);
        if (outcome.outcome === "conflict") new Notice(`Mineral Sync：${file.path} 与服务器版本不一致，已保持冷同步。没有任何内容被覆盖。`);
        // "Unavailable" is not a conflict and no choice can settle it, so it says what actually happened
        // instead of offering a resolution that cannot work.
        else if (outcome.outcome === "rejected") new Notice(`Mineral Sync：服务器暂时无法提供 ${file.path}（${outcome.reason ?? "unavailable"}），热同步没有启动，冷同步不受影响。稍后重新打开该文件即可重试。`);
      }
    } catch (error) {
      this.debug(`hot open failed path-digest=${pathDigest(file.path)} error=${error instanceof Error ? error.message : "unknown"}`);
    }
    this.scheduler?.refreshStatus();
  }

  /**
   * Ends the open hot session.
   *
   * The bytes that are compared against the receipt are the *editor's*, when a view still holds the
   * file: the disk may not have been written yet, and comparing the wrong half would either report a
   * false mismatch or, worse, a false match.
   */
  private closeHotDocument(): Promise<void> {
    ++this.hotDocumentRequest;
    const transition = this.hotDocumentTransition
      .catch(() => undefined)
      .then(() => this.closeHotDocumentNow());
    this.hotDocumentTransition = transition;
    return transition;
  }

  /** Closes the current session from inside the serialized transition queue. */
  private async closeHotDocumentNow(): Promise<void> {
    const coordinator = this.hotCoordinator;
    const path = this.hotOpenPath;
    if (!coordinator || !path) return;
    this.hotOpenPath = undefined;
    try {
      const localText = await this.hotLocalText(path);
      const outcome = await coordinator.close({ canonicalPath: path, localText });
      this.debug(`hot close path-digest=${pathDigest(path)} outcome=${outcome.outcome}${outcome.detail ? ` detail=${outcome.detail}` : ""}`);
      if (outcome.outcome === "handoff-pending") {
        new Notice(`Mineral Sync：${path} 的热会话交接尚未完成，交接期间该文件不会被冷同步覆盖。`);
      }
    } catch (error) {
      this.debug(`hot close failed path-digest=${pathDigest(path)} error=${error instanceof Error ? error.message : "unknown"}`);
    }
    this.scheduler?.refreshStatus();
  }

  private async hotLocalText(path: string): Promise<string> {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path) return view.editor.getValue();
    }
    try {
      return await this.app.vault.adapter.read(path);
    } catch {
      return this.hotCoordinator?.bindingFor(path)?.text() ?? "";
    }
  }

  /**
   * Writes the cold baseline a completed handoff earns.
   *
   * It says "local and remote are both this exact revision", which is the only statement that lets the
   * cold path take the file back without planning an upload of content R2 already has.
   */
  private async commitHotBaseline(path: string, baseline: HotBaseline): Promise<void> {
    let size = 0;
    let mtime = Date.now();
    try {
      const stat = await this.app.vault.adapter.stat(path);
      if (stat) {
        size = stat.size;
        mtime = stat.mtime;
      }
    } catch { /* a missing stat only costs an approximate baseline */ }
    const identity = remoteIdentity(this.settings);
    await this.stateStore.put({
      key: path,
      local: { size, mtime, hash: baseline.contentHash },
      remote: { size, etag: baseline.r2ETag ?? undefined, hash: baseline.contentHash },
      syncedAt: Date.now(),
      remoteIdentity: identity,
      ignorePolicy: ignorePolicyFingerprint(this.settings),
    });
    this.debug(`hot baseline path-digest=${pathDigest(path)} revision=${baseline.documentRevision}`);
    // The file is cold again, and it is identical on both sides: nothing to plan, but the next cycle
    // should at least see the new baseline rather than a stale one.
    this.scheduler?.requestReconcile("hot-handoff");
  }

  /**
   * A rename is two different events depending on who owns the file.
   *
   * - **Cold**: an ordinary local event; both paths are marked and the planner decides.
   * - **Hot**: a namespace operation. The document keeps its identity, the epoch is bumped, and the Vault
   *   writes the new path *and* tombstones the old one. Nothing was produced by an editor, so there is
   *   nothing for the cold path to plan — and marking the new path here would race the namespace
   *   operation and could upload content the room already owns.
   *
   * A refused rename is the exception, and it is the honest one: Obsidian has already moved the file, so
   * the new path really is a local change the cold path has to reconcile.
   */
  private async handleVaultRename(oldPath: string, newPath: string): Promise<void> {
    const coordinator = this.hotCoordinator;
    const hot = Boolean(coordinator) && (this.hotOpenPath === oldPath || coordinator!.isFenced(oldPath));
    if (!hot) {
      this.markLocalPathsUnlessHot([oldPath, newPath]);
      return;
    }
    const applied = await this.renameHotDocument(oldPath, newPath);
    if (!applied) this.markLocalPathsUnlessHot([oldPath, newPath]);
  }

  /**
   * Moves a hot document to its new path.
   *
   * The session keeps running: only the binding moved. The room bumps the epoch and tells every client,
   * so this device's next operation carries the new epoch and a packet from before the rename is
   * refused rather than applied to the new incarnation.
   */
  private async renameHotDocument(fromPath: string, toPath: string): Promise<boolean> {
    const coordinator = this.hotCoordinator;
    if (!coordinator) return false;
    try {
      const result = await coordinator.rename(fromPath, toPath);
      if (result.outcome === "applied") {
        if (this.hotOpenPath === fromPath) this.hotOpenPath = toPath;
        this.debug(`hot renamed path-digest=${pathDigest(fromPath)} epoch=${result.identity?.epoch ?? 0}`);
        return true;
      }
      this.debug(`hot rename refused path-digest=${pathDigest(fromPath)} reason=${result.reason ?? result.outcome}`);
      if (result.outcome === "conflict") new Notice(`Mineral Sync：${fromPath} 的重命名未同步到热会话（${result.reason ?? "conflict"}）。该文件已按普通本地变更进入冷同步，热会话仍持有原路径。`);
      return false;
    } catch (error) {
      this.debug(`hot rename failed path-digest=${pathDigest(fromPath)} error=${error instanceof Error ? error.message : "unknown"}`);
      return false;
    } finally {
      this.scheduler?.refreshStatus();
    }
  }

  /** One line for the settings pane and the status command. Never a path, never content. */
  hotSyncStatusText(): string {
    if (!this.settings.hotSyncEnabled) return "已关闭";
    if (!this.settings.gatewayEnabled) return "需要先启用 Gateway";
    const coordinator = this.hotCoordinator;
    if (!coordinator) return this.hotLastError ? `未启动：${this.hotLastError}` : "未启动";
    const summary = coordinator.summary();
    const open = this.hotOpenPath ? "1" : "0";
    // A path the server could not serve is reported separately: it is not a conflict, and lumping it in
    // with conflicts made a stuck path look like one the user kept failing to resolve.
    const unavailable = coordinator.hotUnavailable();
    const suffix = unavailable.length > 0 ? ` · 服务器不可用 ${unavailable.length}（重新打开文件可重试）` : "";
    return `已启用 · 打开的会话 ${open} · 持有 ${summary.hot} · 待交接 ${summary.handoffPending} · 冲突 ${summary.conflicts} · 冷同步让路 ${summary.deferred.operations}${suffix}`;
  }

  /** Re-derives the channel from the current R2 identity and fences the old connection if it moved. */
  private async applyGatewayConfig(initial: boolean): Promise<void> {
    const gateway = this.gateway;
    if (!gateway) return;
    let identity: RemoteIdentity;
    try { identity = remoteIdentity(this.settings); } catch { identity = { endpoint: this.settings.endpoint, bucket: this.settings.bucket, remotePrefix: this.settings.remotePrefix }; }
    const next = await resolveGatewayConfig({ gatewayEnabled: this.settings.gatewayEnabled, gatewayEndpoint: this.settings.gatewayEndpoint, gatewayToken: this.settings.gatewayToken }, identity);
    this.gatewayConfig = next;
    const channel = next.kind === "ready" ? next.channel : undefined;
    if (initial) await gateway.start(channel); else await gateway.reconfigure(channel);
    if (next.kind === "misconfigured") this.debug(`gateway misconfigured reason=${next.reason}`);
    this.scheduler?.refreshStatus();
  }

  /** Read-only Gateway diagnostics for the connection command and the settings tab. */
  gatewayDiagnostics(): { config: GatewayConfigState; connection?: GatewayClientDiagnostics } {
    return { config: this.gatewayConfig, connection: this.gateway?.diagnostics() };
  }

  /**
   * Read-only mutation-journal diagnostics.
   *
   * The number of deferred reports is the only interesting fact here, and it is the one a silent
   * best-effort path would otherwise hide: a healthy ingress drains to zero within a cycle, while a
   * count that keeps growing means reports are being accepted by nobody.
   */
  mutationIngressStatusText(): string {
    if (!this.settings.mutationIngressEnabled) return "Disabled. Landed writes are announced to the Gateway only.";
    if (!this.settings.gatewayEndpoint.trim() || !this.settings.gatewayToken.trim()) return "Misconfigured. Reporting uses the Gateway endpoint and token above; set both, or turn reporting off. Syncing is unaffected.";
    if (!this.currentChannel()) return "Waiting for the R2 identity: the channel is derived from the endpoint, bucket, and prefix.";
    const pending = this.mutationIngress.pendingCount();
    return `Reported through the Gateway. ${pending === 0 ? "No deferred reports." : `${pending} deferred report${pending === 1 ? "" : "s"} awaiting a retry.`}`;
  }

  gatewayStatusText(): string {
    if (!this.settings.gatewayEnabled) return "Disabled. Syncing uses local events, startup, focus, and the manual command only.";
    if (this.gatewayConfig.kind === "misconfigured") return `Misconfigured (${this.gatewayConfig.reason}). Cold sync is unaffected.`;
    const connection = this.gateway?.diagnostics();
    if (!connection) return "Not started yet.";
    return `Channel ${connection.channelFingerprint ?? "n/a"} · ${connection.state} · announced ${connection.highestAnnouncedGeneration} · reconciled ${connection.lastReconciledGeneration} · pending ${connection.remotePending ? "yes" : "no"}${connection.lastErrorKind ? ` · last error ${connection.lastErrorKind}` : ""}`;
  }

  /**
   * Read-only Gateway diagnostics. Like the status bar, this only reports: it never triggers a
   * reconciliation, never reconnects, and never mints anything. It exists because the most likely
   * Gateway problem is a channel mismatch, and a short channel fingerprint is the only safe way to
   * compare two devices by eye.
   */
  async reportGatewayStatus(): Promise<void> {
    const { config, connection } = this.gatewayDiagnostics();
    if (config.kind === "disabled") { new Notice("Mineral Sync: Sync Gateway is disabled. Cold sync is unaffected."); return; }
    if (config.kind === "misconfigured") { new Notice(`Mineral Sync: Sync Gateway is misconfigured (${config.reason}). Cold sync is unaffected.`); return; }
    if (!connection) { new Notice("Mineral Sync: Sync Gateway has not started yet."); return; }
    const lines = [
      `channel ${connection.channelFingerprint ?? "n/a"}`,
      `state ${connection.state}`,
      `announced ${connection.highestAnnouncedGeneration}`,
      `reconciled ${connection.lastReconciledGeneration}`,
      `pending ${connection.remotePending ? "yes" : "no"}`,
    ];
    if (connection.lastErrorKind) lines.push(`last error ${connection.lastErrorKind}${connection.lastStatus ? ` (HTTP ${connection.lastStatus})` : ""}`);
    this.debug(`gateway status ${lines.join(" · ")}`);
    new Notice(`Mineral Sync Gateway — ${lines.join(" · ")}`);
  }

  private onVisibilityChanged(visible: boolean): void {
    if (visible) this.lastIntegrityRequestedAt = Date.now();
    // An Android buffer owed from before the app went away must reach the file *before* the reconcile
    // reads it: `foreground-resume` schedules its cycle with no debounce, so the save cannot be left
    // racing it. Going hidden is the last moment the WebView is guaranteed to run, hence `force`.
    const settle = (): void => {
      this.scheduler?.visibilityChanged(visible);
      // Phone resume is the one moment a device learns what happened while it was away; the socket is
      // closed while hidden so no background reconnect storm can occur.
      this.gateway?.setVisible(visible);
    };
    if (!Platform.isAndroidApp) { settle(); return; }
    void this.flushPendingAndroidEditorSaves(visible ? "visible" : "hidden", !visible).then(settle, settle);
  }
  private maybeRequestIntegrityReconcile(): void {
    if (document.visibilityState === "hidden") return;
    const interval = Math.max(10, Math.min(30, this.settings.integrityReconcileIntervalMinutes || 20)) * 60_000;
    if (Date.now() - this.lastIntegrityRequestedAt < interval) return;
    this.lastIntegrityRequestedAt = Date.now();
    this.scheduler?.requestReconcile("integrity-check");
  }
  private client(): SignedR2ListClient { return new SignedR2ListClient(this.settings); }
  /**
   * Debug-only operational telemetry: intentionally no paths, content, credentials, or signed headers.
   *
   * Development builds also keep a small ring buffer of the same lines. A device run cannot show a console,
   * and "the resolution failed" is not a diagnosis: when a hot resolution fails, the last lines are written
   * next to `data.json`, which is the only way to see *which* gate refused the decision on that device.
   */
  private debug(message: string): void {
    if (this.settings.debugLogging) console.log(`[Mineral Obsidian Sync] ${message}`);
    if (__DEV__) {
      this.debugRing.push(`${new Date().toISOString()} ${message}`);
      if (this.debugRing.length > 200) this.debugRing.splice(0, this.debugRing.length - 200);
    }
  }

  /**
   * Applies a status presentation to the status bar.
   *
   * The presentation itself is computed by a pure function, so what each state *looks like* is pinned by
   * tests rather than by this method's branches.
   */
  private renderStatus(presentation: SyncStatusPresentation): void {
    this.statusPresentation = presentation;
    if (this.statusBar) renderSyncStatus(this.statusBar, presentation);
  }

  private setSchedulerStatus(state: SchedulerState, counts: ResultCounts): void {
    // A plan-level conflict is only a detection: the resolver can act only on the durable record the
    // coordinator established from it, so the count advertised here is that record count, never the
    // plan's. Everything else comes from the scheduler's own diagnostics, so no new state is invented.
    this.renderStatus(presentSyncStatus({
      state,
      counts,
      conflictCount: this.lastConflictCount,
      lastFailureClass: this.scheduler?.diagnostics?.().lastFailureClass,
      // Only when the hot layer is running: with it off the cold presentation is byte-for-byte what it
      // was before the feature existed.
      ...(this.hotCoordinator ? { hot: this.hotStatusInput() } : {}),
    }));
    this.maybePruneTombstones(state);
  }

  /**
   * The hot layer's state, in the shape the status bar reads.
   *
   * The open document's own session is the interesting one, but the counts matter too: a handoff that
   * never completed keeps fencing a file *after* its pane is gone, and a conflict keeps fencing it until
   * someone acts. Both would be invisible in a bar that only looked at the current pane.
   */
  private hotStatusInput(): HotStatusInput {
    const coordinator = this.hotCoordinator;
    const summary = coordinator?.summary() ?? { hot: 0, handoffPending: 0, conflicts: 0, deferred: { paths: 0, operations: 0 } };
    const open = this.hotOpenPath ? coordinator?.statusOf(this.hotOpenPath) : undefined;
    const session = this.hotOpenPath ? coordinator?.sessionFor(this.hotOpenPath)?.session : undefined;
    return {
      status: (open?.status ?? "idle") as HotStatusInput["status"],
      pendingSave: Boolean(session?.pendingSave),
      handoffPending: summary.handoffPending,
      conflicts: summary.conflicts,
    };
  }

  /**
   * Tombstone retention runs once per session, and only once a reconciliation has finished.
   *
   * Deliberately not at load time. Reading the tombstone namespace is the same work a full reconcile
   * already does, so doing it while a cycle is in flight would double that work and could interleave a
   * removal with the scan reading the same records. Waiting for the first cycle costs nothing: the
   * retention window is measured in weeks, so a few seconds either way cannot matter.
   */
  private maybePruneTombstones(state: SchedulerState): void {
    if (this.tombstoneCleanup === "done") return;
    if (state === "running") { this.tombstoneCleanup = "ready"; return; }
    if (this.tombstoneCleanup !== "ready") return;
    this.tombstoneCleanup = "done";
    void this.pruneTombstones();
  }

  /**
   * Removes tombstones that are old *and* that this device provably no longer needs.
   *
   * There is no cluster-wide acknowledgement that every device has seen a deletion, so age alone is
   * never sufficient. The protections below are the concrete evidence this device has: an unresolved
   * conflict (which is where a pending decision lives, since a decision can only be authored against a
   * detected conflict), a baseline that still describes the path, or a local file that is still here.
   * All three mean "this deletion has not finished happening on this device", and until it has, the
   * record that names the deleted version is still load-bearing.
   *
   * Best effort and silent: this is metadata housekeeping on a path that has nothing to do with the
   * sync decision, so a failure is a debug line and nothing else.
   */
  private async pruneTombstones(): Promise<void> {
    if (!this.settings.endpoint.trim() || !this.settings.bucket.trim()) return;
    try {
      const channel = await this.resolveChannel();
      if (!channel) return;
      this.coordinator?.setChannel(channel);
      const settings: R2SyncSettings = { ...this.settings, ignoredPaths: [...this.settings.ignoredPaths] };
      const filter = createVaultPathFilter(settings);
      const client = new SignedR2ListClient(settings, undefined, undefined, undefined, (message) => this.debug(message));
      const [baselines, records] = await Promise.all([this.stateStore.loadAll(), this.coordinator?.list() ?? Promise.resolve([])]);
      const protections = {
        conflicted: new Set(records.map((record) => record.path)),
        baselines: new Set(baselines.keys()),
        ignored: (key: string) => filter.ignores(key),
        localFilePresent: (key: string) => this.app.vault.getFileByPath(key) !== null,
      };
      await pruneExpiredTombstones(client, {
        now: Date.now(),
        protect: (path) => protectedFromCleanup(protections, path),
        debug: (message) => this.debug(message),
      });
    } catch (error) {
      this.debug(`tombstone cleanup skipped class=${error instanceof Error ? error.name : "unknown"}`);
    }
  }

  /** Busy and error status for the paths that are not a reconcile cycle (inspection, self-tests). */
  private showBusyStatus(message: string): void {
    this.renderStatus({ tone: "syncing", icon: SYNC_STATUS_ICON, spinning: true, tooltip: `Mineral Sync\n${message}`, action: "sync-now" });
  }
  private showErrorStatus(message: string): void {
    this.renderStatus({ tone: "error", icon: SYNC_STATUS_ICON, spinning: false, badge: "!", tooltip: `Mineral Sync\n${message}`, action: "sync-now" });
  }

  /**
   * A conflict needs a decision, so its click lands on the resolver directly; every other state asks for
   * a reconcile instead. The action comes from the last presentation, so the two can never disagree.
   */
  private onStatusClick(): void {
    const action = this.statusPresentation?.action ?? "sync-now";
    if (action === "resolve-hot-conflicts") { this.openHotConflictResolver(); return; }
    if (action === "resolve-conflicts") { void this.openConflictResolver(); return; }
    this.scheduler?.requestReconcile("manual");
  }

  /**
   * The entry point for the conflicts the cold resolver cannot settle.
   *
   * A hot conflict is "this device's version versus the authority's version", not two files to diff, so
   * it gets its own screen and its own two decisions. The list comes from the coordinator, which is why
   * it can include paths whose pane is long gone — a handoff that never completed keeps fencing a file
   * that is no longer open.
   */
  private openHotConflictResolver(): void {
    const coordinator = this.hotCoordinator;
    if (!coordinator) {
      new Notice("Mineral Sync：热同步当前没有运行。");
      return;
    }
    const conflicts = coordinator.hotConflicts();
    if (conflicts.length === 0) {
      new Notice("Mineral Sync：没有需要处理的热同步冲突。");
      return;
    }
    // What each side holds is part of the question, so it is gathered before the user is asked. A blind
    // "keep local / take the other side" is how a choice to overwrite real work gets made by accident.
    void Promise.all(conflicts.map(async conflict => {
      let localSize: number | undefined;
      let remoteSize: number | undefined;
      try { localSize = (await this.app.vault.adapter.stat(conflict.canonicalPath))?.size ?? undefined; } catch { /* unreadable: shown as unknown */ }
      try { remoteSize = (await coordinator.pathStatus(conflict.canonicalPath)).remote?.size ?? undefined; } catch { /* unreachable: shown as unknown */ }
      return { ...conflict, ...(localSize === undefined ? {} : { localSize }), ...(remoteSize === undefined ? {} : { remoteSize }) };
    })).then(entries => {
      new HotConflictModal(this.app, entries, async (canonicalPath, decision) => {
        // The pane's editor is handed over when there is one, so "keep local" can put the chosen text back
        // where the user is looking; a conflict for a file that is not open in a pane gets a headless
        // carrier, because the file on disk is what a resolution reads and writes either way.
        const result = await coordinator.resolveConflict(canonicalPath, decision, this.markdownViewFor(canonicalPath)?.editor);
        this.debug(`hot resolve path-digest=${pathDigest(canonicalPath)} decision=${decision} outcome=${result.outcome}${result.detail ? ` detail=${result.detail}` : ""}`);
        // A development build leaves the reasoning on disk, because the device that refused the decision is
        // the only one that can say which gate did it.
        if (__DEV__ && result.outcome === "failed") {
          const report = [
            `outcome: ${result.outcome} detail: ${result.detail ?? "none"}`,
            `decision: ${decision}`,
            `status: ${this.hotSyncStatusText()}`,
            "",
            ...this.debugRing.slice(-60),
            "",
          ].join("\n");
          void this.app.vault.adapter.write("private/mineral-sync-hot-selftest/resolve-failure.txt", report).catch(() => undefined);
        }
        if (result.outcome !== "failed") this.scheduler?.refreshStatus();
        return result;
      }).open();
    });
  }

  /**
   * Right-click is the secondary surface. It is kept to two entries on purpose: history is the one thing
   * a user needs *about* sync rather than *to* it, and everything else already has a command.
   */
  private openStatusMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Sync history").setIcon("history").onClick(() => void this.openSyncHistory()));
    menu.addItem((item) => item.setTitle("Status details").setIcon("info").onClick(() => this.reportStatusDetails()));
    menu.showAtMouseEvent(event);
  }

  /**
   * Opens the history viewer for the current channel.
   *
   * History is keyed by channel, so it follows the namespace in use rather than the vault as a whole:
   * pointing the plugin at a different bucket does not show, or offer to restore, versions that came
   * from another one. The restore itself is delegated to the plugin, which writes locally and lets the
   * planner decide the rest.
   */
  private async openSyncHistory(): Promise<void> {
    const channel = this.currentChannel() ?? await this.resolveChannel();
    if (!channel) { new Notice("Mineral Sync: sync history needs a configured endpoint and bucket."); return; }
    new SyncHistoryModal(this.app, {
      list: () => this.history.list(channel),
      restore: (input) => this.restoreFromHistory(input),
      debug: (message) => this.debug(message),
    }).open();
  }

  /**
   * Right-click is the details surface. There is no popover framework here and this does not need one:
   * the point is that the facts stay reachable without occupying the status bar.
   */
  private reportStatusDetails(): void {
    const diagnostics = this.scheduler?.diagnostics?.();
    const lines = [
      `state ${diagnostics?.currentState ?? "unknown"}`,
      `last cycle ${diagnostics?.lastCycleReason ?? "n/a"}`,
      `conflicts ${this.lastConflictCount}`,
    ];
    if (diagnostics?.lastFailureClass) lines.push(`last failure ${diagnostics.lastFailureClass}`);
    if (diagnostics?.pendingDirtyCount) lines.push(`pending local paths ${diagnostics.pendingDirtyCount}`);
    if (diagnostics?.pendingRemoteDeltaCount) lines.push(`pending remote deltas ${diagnostics.pendingRemoteDeltaCount}`);
    // The hot layer's own state, so "syncing" is never a single word covering four different situations.
    if (this.settings.hotSyncEnabled) lines.push(this.hotSyncStatusText());
    this.debug(`status details ${lines.join(" · ")}`);
    new Notice(`Mineral Sync — ${lines.join("\n")}`);
  }
  private registerVaultListeners(): void {
    // A hot path is not a cold candidate. Every local event funnels through this guard, so a hot
    // document's own writes can never be re-registered as ordinary local modifications — which is the
    // difference between collaboration and a feedback loop.
    const mark = (path: string) => this.markLocalUnlessHot(path);
    this.registerEvent(this.app.vault.on("create", (file) => { if (!(file instanceof TFolder)) mark(file.path); }));
    this.registerEvent(this.app.vault.on("modify", (file) => { if (!(file instanceof TFolder)) void this.markUnlessOwnEditorWrite(file.path); }));
    // A deleted folder cannot be reliably distinguished after removal; treating it as dirty is the safe side.
    this.registerEvent(this.app.vault.on("delete", (file) => {
      mark(file.path);
      if (!(file instanceof TFile)) return;
      // The hot session, the server binding, the R2 object and the tombstone must all agree that this
      // file is gone. An earlier version only called `forget()`, which dropped the local record but
      // never told the room: the binding stayed live, R2 kept the body, and another device could
      // download the "deleted" content again. The namespace delete is the server's half of the truth;
      // `forget()` then cleans up whatever the room refused to take.
      const coordinator = this.hotCoordinator;
      if (!coordinator) return;
      void (async () => {
        const path = file.path;
        try {
          const result = await coordinator.delete(path);
          if (result.outcome !== "applied") {
            this.debug(`hot delete not applied outcome=${result.outcome} reason=${result.reason ?? "-"} path-digest=${pathDigest(path)}`);
            new Notice(`Mineral Sync：${path} 的删除尚未由服务器确认（${result.reason ?? result.outcome}）。该路径仍保持围栏，稍后会继续恢复，旧正文不会被静默复活。`);
          } else {
            this.hotRecentBuffers.delete(path);
            this.hotDiskText.delete(path);
          }
        } catch (error) {
          this.debug(`hot delete failed: ${error instanceof Error ? error.message : "unknown"}`);
          new Notice(`Mineral Sync：${path} 的删除请求暂时失败。该路径仍保持热同步围栏，等待恢复。`);
        }
      })();
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFolder) return;
      void this.handleVaultRename(oldPath, file.path);
    }));
    this.registerEvent(this.app.workspace.on("file-open", (file) => { if (file) void this.openHotDocument(file); else void this.closeHotDocument(); }));
    if (__DEV__) {
      /**
       * Development only: leave the hot layer's state on disk whenever a file is opened.
       *
       * The failure this exists for is *silent* — the path is owned on the server, keystrokes vanish, and
       * nothing anywhere says why. A device run cannot show a console, so the state is written where it can
       * be read afterwards: whether the layer even started, which file it thinks is open, and whether the
       * document the session holds has the same size as the buffer being typed into.
       */
      let lastStateWrite = 0;
      this.registerEvent(this.app.workspace.on("file-open", (file) => {
        if (!file || Date.now() - lastStateWrite < 10_000) return;
        lastStateWrite = Date.now();
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const lines = [
          `status: ${this.hotSyncStatusText()}`,
          `openedFile: ${file.path}`,
          `hotOpenPath: ${this.hotOpenPath ?? "none"}`,
          `editorLength: ${(view?.file?.path === file.path ? view.editor.getValue().length : -1)}`,
          `documentLength: ${this.hotCoordinator?.bindingFor(file.path)?.text().length ?? -1}`,
          "",
        ];
        void this.app.vault.adapter.write("private/mineral-sync-hot-selftest/hot-state.txt", lines.join("\n")).catch(() => undefined);
      }));
    }
    this.registerEvent(this.app.workspace.on("editor-change", (editor, info) => {
      const coordinator = this.hotCoordinator;
      if (!coordinator) return;
      const path = info instanceof MarkdownView ? info.file?.path : undefined;
      if (!path) return;
      /**
       * The decision is made from the *session*, never from `hotOpenPath`.
       *
       * That flag only records the file this plugin deliberately opened last. A session can exist without
       * it — a resumed session, or one whose file-open arrived before the layout was ready — and gating on
       * the flag then means every keystroke is dropped in silence: the path is owned on the server, R2 never
       * changes, and nothing anywhere says why. A real user hit exactly that, twice, with a note whose
       * session was live and whose edits went nowhere.
       */
      const hot = coordinator.bindingFor(path) !== undefined;
      if (!hot) {
        // Typing in a file that has no session is itself the reason to open one. The first keystroke is not
        // lost: the session is seeded from the buffer that already contains it.
        if (info instanceof MarkdownView && info.file) {
          this.debug(`hot adopt path-digest=${pathDigest(path)} reason=typed-without-session`);
          void this.openHotDocument(info.file);
        }
        return;
      }
      // The pane's editor is not necessarily the instance the session was opened against — Obsidian rebuilds
      // editors when a workspace is restored or a tab moves. The diff is computed from the *bound* editor's
      // value, so without this the keystrokes land in a buffer nobody reads. "Adopt" because the editor that
      // just fired is the one being typed into.
      this.recordHotBufferSnapshot(path, editor.getValue());
      coordinator.rebind(path, editor, "adopt");
      void coordinator.handleEditorChange(path).catch(error => {
        this.debug(`hot editor update failed path-digest=${pathDigest(path)} error=${error instanceof Error ? error.message : "unknown"}`);
      });
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      // Moving to another pane changes which editor is on screen without changing the file. A session that
      // stays bound to the previous instance is silent, so the pane is adopted as soon as it is focused.
      const coordinator = this.hotCoordinator;
      const path = this.hotOpenPath;
      if (!coordinator || !path) return;
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view?.file?.path === path) coordinator.rebind(path, view.editor, "fill");
    }));
    if (Platform.isAndroidApp) {
      this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
        if (info instanceof MarkdownView && info.file) this.scheduleAndroidEditorSave(info.file.path);
      }));
      // Leaving a note is when its buffer is most likely to be stranded, because the save that was
      // scheduled for it is still 500 ms away. Write what is owed first.
      this.registerEvent(this.app.workspace.on("active-leaf-change", () => { void this.flushPendingAndroidEditorSaves("active-leaf-change"); }));
    }
  }

  /**
   * Marks a path dirty unless a hot session owns it.
   *
   * The cold planner can still *observe* a fenced path; it may not act on one. Recording the deferral
   * instead of the modification is what keeps a hot file from being uploaded by the cold path with a
   * stale baseline, and it leaves an operator-visible count rather than silence.
   */
  private markLocalUnlessHot(path: string): void {
    if (this.hotCoordinator?.isFenced(path)) {
      this.hotCoordinator.noteDeferred(path);
      return;
    }
    this.scheduler?.markLocalPaths([path], (key) => createVaultPathFilter(this.settings).ignores(key));
  }

  private markLocalPathsUnlessHot(paths: string[]): void {
    const fenced = paths.filter((path) => this.hotCoordinator?.isFenced(path));
    for (const path of fenced) this.hotCoordinator?.noteDeferred(path);
    const cold = paths.filter((path) => !fenced.includes(path));
    if (cold.length > 0) this.scheduler?.markLocalPaths(cold, (key) => createVaultPathFilter(this.settings).ignores(key));
  }

  /**
   * Marks a path dirty unless the write behind this Vault event is one this plugin's own editor save
   * just performed.
   *
   * That save already marked the path with the shorter `editor-change` reason. Letting its own event
   * mark it again would replace that with the ordinary 1200 ms debounce — or, when Android defers the
   * event past the cycle, spend a whole extra cycle on a HEAD that can only answer "noop".
   */
  private async markUnlessOwnEditorWrite(path: string): Promise<void> {
    try {
      const recorded = this.androidEditorWriteStamps.get(path);
      if (recorded && isOwnWrite(recorded, await this.app.vault.adapter.stat(path))) {
        this.androidEditorWriteStamps.delete(path);
        this.debug(`android editor-change own-write event suppressed path-digest=${pathDigest(path)}`);
        return;
      }
    } catch { /* an unreadable stamp only costs a redundant cycle */ }
    if (await this.flagExternalHotEdit(path)) return;
    this.markLocalUnlessHot(path);
  }

  /**
   * Detects a write to a hot file that did not come from the buffer its session is bound to.
   *
   * Identification is *content-based*, not time-based. The vault modify handler fires for both Obsidian's
   * own autosaves and for any other writer (a sync tool, another plugin, an external editor). The two
   * cases are told apart by asking "could these bytes be the buffer at some moment this device owns?".
   *
   * The plugin keeps a short history of buffer snapshots on every editor-change; a vault event whose
   * payload matches one of those snapshots is our own autosave even if it landed ten seconds after the
   * keystroke. A payload that matches none of them — and is not the current buffer either — is external
   * by definition, regardless of timing.
   *
   * Returns `true` when the modification was classified as external, so the caller stops before it
   * registers an ordinary cold change for the path.
   */
  private async flagExternalHotEdit(path: string): Promise<boolean> {
    const coordinator = this.hotCoordinator;
    if (!coordinator?.isFenced(path)) return false;
    const view = this.markdownViewFor(path);
    // No pane holds the file: there is no buffer to compare against, and the cold path is fenced
    // anyway, so a decision here would be a guess.
    if (!view) return false;
    let disk: string;
    try { disk = await this.app.vault.adapter.read(path); }
    catch { return false; }

    const previous = this.hotDiskText.get(path);
    this.hotDiskText.set(path, disk);
    if (previous === undefined || previous === disk) return false;
    const buffer = view.editor.getValue();
    // The disk is exactly what the buffer shows: this is an autosave that caught up (or no change at
    // all, in the rare case the autosave reported the same bytes twice). Either way it is ours.
    if (disk === buffer) return false;
    // The disk matches one of the recent buffer snapshots: this plugin wrote it. Obsidian's autosave
    // can land arbitrarily later than the keystroke (network, suspend, large file) — the snapshot
    // window is what makes "late" writes still attributable to us.
    if (this.isRecentHotBuffer(path, disk)) return false;

    if (!coordinator.flagExternalEdit(path)) return true;
    new Notice(`Mineral Sync：${path} 在热会话期间被外部修改，该文件的冷同步已暂停以避免覆盖。请确认磁盘内容后再决定保留哪一份。`);
    return true;
  }

  /**
   * Records the buffer contents at the moment of an editor-change so a later vault event can be
   * classified as our own autosave.
   *
   * Snapshots are kept in arrival order, deduplicated against their predecessor, and trimmed to a small
   * window; the goal is "any plausible autosave delay", not "infinite history". The buffer can be a few
   * megabytes and the vault fires often, so the cap is intentionally bounded.
   */
  private recordHotBufferSnapshot(path: string, text: string): void {
    const history = this.hotRecentBuffers.get(path);
    const last = history?.at(-1);
    if (last && last.text === text) {
      last.at = Date.now();
      return;
    }
    const next = history ? [...history, { text, at: Date.now() }] : [{ text, at: Date.now() }];
    const trimmed = HOT_BUFFER_SNAPSHOT_RETENTION_MS;
    const cutoff = Date.now() - trimmed;
    while (next.length > 1 && next[0].at < cutoff) next.shift();
    while (next.length > HOT_BUFFER_SNAPSHOT_MAX) next.shift();
    this.hotRecentBuffers.set(path, next);
  }

  /** True when the bytes on disk equal one of the recent buffer snapshots this plugin owns. */
  private isRecentHotBuffer(path: string, text: string): boolean {
    const history = this.hotRecentBuffers.get(path);
    if (!history) return false;
    const cutoff = Date.now() - HOT_BUFFER_SNAPSHOT_RETENTION_MS;
    const current = history.filter(entry => entry.at >= cutoff);
    if (current.length === 0) this.hotRecentBuffers.delete(path);
    else if (current.length !== history.length) this.hotRecentBuffers.set(path, current);
    return current.some(entry => entry.text === text);
  }

  /** The MarkdownView showing a path, if any. A leaf can change files, so it is resolved on demand. */
  private markdownViewFor(path: string): MarkdownView | undefined {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path) return view;
    }
    return undefined;
  }

  /**
   * Obsidian Android can retain edits in the active MarkdownView until that view loses focus. Save the
   * view after a short quiet period so the normal Vault event and normal sync pipeline can see it. The
   * editor buffer is never uploaded directly: after save, SafeExecutor rereads stable Vault bytes and
   * still applies the usual remote preconditions.
   */
  private scheduleAndroidEditorSave(path: string): void {
    if (!path || createVaultPathFilter(this.settings).ignores(path)) return;
    this.androidPendingEditorSaves.add(path);
    const previous = this.androidEditorSaveTimers.get(path);
    if (previous !== undefined) window.clearTimeout(previous);
    const handle = window.setTimeout(() => {
      this.androidEditorSaveTimers.delete(path);
      void this.flushAndroidEditorSave(path);
    }, ANDROID_EDITOR_SAVE_DEBOUNCE_MS);
    this.androidEditorSaveTimers.set(path, handle);
  }

  /** The view showing a path, if any. Resolved on demand, because a leaf can change files. */
  private androidMarkdownView(path: string): MarkdownView | undefined {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path) return view;
    }
    return undefined;
  }

  private androidMarkdownViews(): MarkdownView[] {
    const views: MarkdownView[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) if (leaf.view instanceof MarkdownView) views.push(leaf.view);
    return views;
  }

  /**
   * Writes one owed editor buffer with the Vault, then reports what that means for the sync pipeline.
   *
   * The buffer is the thing at risk here: every other trigger in the plugin reads the file, so an
   * unsaved buffer is invisible to all of them. That is why a save which cannot run *now* is kept owed
   * rather than dropped — a dropped save leaves the path blind until the user happens to type again,
   * which is exactly the "it only syncs after I type something" symptom.
   */
  private async flushAndroidEditorSave(path: string, force = false): Promise<void> {
    if (this.androidEditorSavesInFlight.has(path)) return;
    const view = this.androidMarkdownView(path);
    const action = flushAction({ hidden: document.visibilityState === "hidden", hasView: Boolean(view), force });
    if (action === "retry-later") return;
    this.androidPendingEditorSaves.delete(path);
    const mark = (reason: "local-event" | "editor-change") => this.scheduler?.markLocalPaths([path], (key) => createVaultPathFilter(this.settings).ignores(key), reason);
    if (action === "mark-only") {
      // The buffer died with its view, so the only useful action left is to make a cycle re-read the file.
      this.debug(`android editor-change view-gone path-digest=${pathDigest(path)}`);
      mark("local-event");
      return;
    }
    this.androidEditorSavesInFlight.add(path);
    try {
      const before = await this.app.vault.adapter.stat(path);
      await view!.save();
      const after = await this.app.vault.adapter.stat(path);
      // A download Obsidian reloaded into the editor also fires `editor-change`. Saving that buffer
      // writes nothing new, and reporting it would spend a whole extra cycle on a HEAD answering noop.
      if (!writeChangedFile(before, after)) { this.debug(`android editor-change noop path-digest=${pathDigest(path)}`); return; }
      if (after) this.androidEditorWriteStamps.set(path, { size: after.size, mtime: after.mtime });
      this.debug(`android editor-change saved path-digest=${pathDigest(path)}`);
      mark("editor-change");
    } catch {
      // A view can be torn down mid-save. The buffer is gone with it, so the path is marked dirty and a
      // cycle re-reads whatever the Vault ended up with, rather than leaving the edit unaccounted for.
      this.debug(`android editor-change save failed path-digest=${pathDigest(path)}`);
      mark("local-event");
    } finally { this.androidEditorSavesInFlight.delete(path); }
  }

  /**
   * Writes every owed buffer, and returns the paths it wrote.
   *
   * Used wherever a pending save must not wait for its own timer: the app going away, coming back, the
   * user leaving a note, and the periodic drift tick. The returned paths are the ones the caller must
   * not report as drift, because their write is this plugin's own doing.
   */
  private async flushPendingAndroidEditorSaves(trigger: string, force = false): Promise<string[]> {
    if (!this.androidPendingEditorSaves.size) return [];
    const paths = [...this.androidPendingEditorSaves];
    for (const path of paths) {
      const handle = this.androidEditorSaveTimers.get(path);
      if (handle !== undefined) { window.clearTimeout(handle); this.androidEditorSaveTimers.delete(path); }
    }
    this.debug(`android editor-flush trigger=${trigger} pending=${paths.length}`);
    const written: string[] = [];
    for (const path of paths) {
      const hadBuffer = this.androidPendingEditorSaves.has(path);
      await this.flushAndroidEditorSave(path, force);
      if (hadBuffer && !this.androidPendingEditorSaves.has(path)) written.push(path);
    }
    return written;
  }

  /**
   * Last-resort check for a buffer nothing told us about — an edit made before this plugin instance (or
   * its pending record) existed, or one whose events were lost while Android kept the app backgrounded.
   * It compares the buffer with the file and writes it when they disagree, so a stranded edit heals
   * within one drift tick instead of waiting for the user to type again.
   */
  private async flushDivergentEditorBuffers(): Promise<string[]> {
    const written: string[] = [];
    for (const view of this.androidMarkdownViews()) {
      const path = view.file?.path;
      if (!path || createVaultPathFilter(this.settings).ignores(path)) continue;
      try {
        const stat = await this.app.vault.adapter.stat(path);
        if (!stat || stat.size > ANDROID_BUFFER_COMPARISON_MAX_BYTES) continue;
        const buffered = view.editor.getValue();
        if (buffered === await this.app.vault.read(view.file!)) continue;
        this.debug(`android editor-buffer diverged path-digest=${pathDigest(path)} chars=${buffered.length}`);
        this.androidPendingEditorSaves.add(path);
        await this.flushAndroidEditorSave(path);
        if (!this.androidPendingEditorSaves.has(path)) written.push(path);
      } catch { /* an unreadable view is not a sync failure and must not schedule remote work */ }
    }
    return written;
  }

  /** Android foreground-only fallback for missed Vault events; it never schedules an unchanged vault. */
  private registerAndroidLocalDriftDetector(): void {
    if (!Platform.isAndroidApp) return;
    void this.pollAndroidLocalDrift();
    this.registerInterval(window.setInterval(() => { void this.pollAndroidLocalDrift(); }, ANDROID_LOCAL_DRIFT_INTERVAL_MS));
  }
  private async pollAndroidLocalDrift(): Promise<void> {
    if (this.androidLocalDriftPollRunning || document.visibilityState === "hidden") return;
    this.androidLocalDriftPollRunning = true;
    try {
      // First the buffers: an owed or diverged buffer is written before the metadata scan runs, so the
      // scan is looking at what the Vault actually holds.
      const written = new Set([...(await this.flushPendingAndroidEditorSaves("drift-tick")), ...(await this.flushDivergentEditorBuffers())]);
      const next = await scanLocalAdapterMetadata(this.app.vault, createVaultPathFilter(this.settings));
      const previous = this.androidLocalSnapshot;
      this.androidLocalSnapshot = next;
      if (!previous) return;
      // A path this tick just wrote is already marked, and its own metadata is what changed it.
      const changed = changedLocalKeys(previous, next).filter((key) => !written.has(key));
      if (!changed.length) return;
      // A file the plugin itself downloaded also changes its metadata, and marking it would spend a
      // whole extra cycle on a HEAD that can only answer "noop". A download commits the baseline for
      // the version it wrote, so only paths that disagree with the recorded baseline are real drift.
      const unsynced = changed.length > ANDROID_DRIFT_BASELINE_LIMIT ? changed : await this.unsyncedLocalDrift(next, changed);
      if (!unsynced.length) { this.debug(`android local-drift entries=${changed.length} unsynced=0`); return; }
      this.debug(`android local-drift entries=${changed.length} unsynced=${unsynced.length}`);
      this.scheduler?.markLocalPaths(unsynced, () => false);
    } catch {
      // A transient Android storage read is not a sync failure and must not trigger remote work.
      this.debug("android local-drift metadata-scan-failed");
    } finally { this.androidLocalDriftPollRunning = false; }
  }

  /**
   * Narrows observed drift to paths the recorded baseline does not already describe.
   *
   * A baseline is replaced only by a completed transfer, so "the file moved" and "the file is not
   * synced" are different questions, and only the second one is worth a cycle. A key with no usable
   * baseline is always reported: the conservative answer can only cost a cycle, never a missed edit.
   */
  private async unsyncedLocalDrift(current: Map<string, LocalEntry>, changed: string[]): Promise<string[]> {
    let stored: Map<string, PreviousEntry>;
    try { stored = await this.stateStore.loadAll(); } catch { return changed; }
    const identity = remoteIdentity(this.settings);
    const ignorePolicy = ignorePolicyFingerprint(this.settings);
    return changed.filter((key) => {
      const local = current.get(key);
      if (!local) return true;
      const baseline = stored.get(key);
      if (!baseline || baseline.ignorePolicy !== ignorePolicy) return true;
      if (baseline.remoteIdentity?.endpoint !== identity.endpoint || baseline.remoteIdentity.bucket !== identity.bucket || baseline.remoteIdentity.remotePrefix !== identity.remotePrefix) return true;
      return localChanged(local, baseline);
    });
  }
  /**
   * The only destructive capability handed to the executor: move a file to trash, honouring the
   * user's "Deleted files" setting. It never permanently unlinks.
   *
   * `FileManager.trashFile` is the modern entry point (Obsidian 1.5+, which matches our
   * `minAppVersion`); `Vault.trash` is the older equivalent. Both fall back to the same user
   * preference, and one of them exists on every supported version.
   */
  private vaultFileRemover(): VaultFileRemover {
    const fileManager = this.app.fileManager as { trashFile?: (file: TFile) => Promise<void> };
    if (typeof fileManager?.trashFile === "function") return { trash: (file) => fileManager.trashFile!(file) };
    const vault = this.app.vault as { trash?: (file: TFile, system: boolean) => Promise<void> };
    if (typeof vault?.trash === "function") return { trash: (file) => vault.trash!(file, false) };
    // No recovery-capable API exists, so no destructive action is permitted at all.
    return { trash: async () => { throw new Error("this Obsidian version exposes no trash API"); } };
  }
  private captureSchedulerCycle() {
    const settings: R2SyncSettings = { ...this.settings, ignoredPaths: [...this.settings.ignoredPaths] };
    const filter = createVaultPathFilter(settings);
    const ignorePolicy = ignorePolicyFingerprint(settings);
    const identity = remoteIdentity(settings);
    const client = new SignedR2ListClient(settings, undefined, undefined, undefined, (message) => this.debug(message));
    const channel = this.currentChannel();
    const executor = new SafeExecutor(this.app.vault, client, this.stateStore, identity, ignorePolicy, this.vaultFileRemover(), channel ? createMergeBaseRecorder(this.app.vault, channel, this.conflictStores) : undefined, (message) => this.debug(message));
    // One definition of a usable baseline, shared by every observation path in the cycle: a baseline from
    // another namespace, or one invalidated by an ignore-policy change, must never decide anything.
    const acceptsBaseline = (key: string, entry: PreviousEntry): boolean =>
      !filter.ignores(key) && entry.ignorePolicy === ignorePolicy && entry.remoteIdentity?.endpoint === identity.endpoint && entry.remoteIdentity.bucket === identity.bucket && entry.remoteIdentity.remotePrefix === identity.remotePrefix;
    // Scanned once per cycle and shared by planning and conflict observation, so both see exactly the
    // same observations and no second scan can disagree with the planner's inputs.
    return {
      // Android may retain stale TFile.stat after an omitted Vault event. The adapter is the
      // authoritative local metadata source for both planning and the foreground drift fallback.
      scanLocal: () => Platform.isAndroidApp ? scanLocalAdapterMetadata(this.app.vault, filter) : scanLocal(this.app.vault, filter),
      scanRemote: () => scanRemote(client, filter, (message) => this.debug(message)),
      // A Gateway delta is answered path by path: what the event omits is filled in by one exact
      // request, never by a listing. The rules live in `sync/remote-delta` so that they can be tested
      // against the request pattern they are supposed to have.
      incrementalObservations: (changes: RemoteChange[]) => observeRemoteDelta(changes, {
        client,
        ignores: (key) => filter.ignores(key),
        loadPrevious: () => this.stateStore.loadAll(),
        statLocal: (key) => this.app.vault.adapter.stat(key),
        acceptsBaseline,
      }),
      localIncrementalObservations: (keys: string[]) => observeLocalDelta(keys, {
        client,
        ignores: (key) => filter.ignores(key),
        loadPrevious: () => this.stateStore.loadAll(),
        statLocal: (key) => this.app.vault.adapter.stat(key),
        acceptsBaseline,
      }),
      loadPrevious: () => this.stateStore.loadAll(),
      filterPrevious: (storedPrevious: Awaited<ReturnType<IndexedDbStateStore["loadAll"]>>) => new Map([...storedPrevious].filter(([key, entry]) => !filter.ignores(key) && entry.ignorePolicy === ignorePolicy && entry.remoteIdentity?.endpoint === identity.endpoint && entry.remoteIdentity.bucket === identity.bucket && entry.remoteIdentity.remotePrefix === identity.remotePrefix)),
      buildPlan: async (local: Map<string, LocalEntry>, remote: Map<string, RemoteEntry>, previous: Map<string, PreviousEntry>) => {
        // A completed hot handoff, an interrupted first download, or an older client can leave the same
        // bytes on both sides without a cold baseline. Treating that pair as `both-created-different`
        // permanently strands the file: the conflict coordinator intentionally cannot resolve a
        // conflict that has no ancestor. Verify the bytes here, in the real scheduler path, and persist
        // only proven-identical pairs before the deterministic planner runs.
        const bootstrap = await buildBootstrapResult(local, remote, previous, {
          readLocal: (_key, expected) => readStableLocalBytes(this.app.vault, expected),
          readRemote: (key, expected) => client.getObject(key, { ifMatch: expected.etag }),
        }, undefined, identity, ignorePolicy);
        await this.stateStore.saveVerified(bootstrap.baselineCandidates);
        if (bootstrap.baselineCandidates.size) this.debug(`cycle bootstrap verified=${bootstrap.baselineCandidates.size}`);
        const verifiedPrevious = new Map(previous);
        for (const [key, entry] of bootstrap.baselineCandidates) verifiedPrevious.set(key, entry);
        return buildSyncPlan(local, remote, verifiedPrevious, this.coordinator?.resolutions(), {
          // Ownership is a plan input, not only an execution check: a hot path must never be described as
          // an upload, a download, or a deletion inference that some later stage has to remember to skip.
          deferPath: (key) => this.hotCoordinator?.isFenced(key) ?? false,
        });
      },
      execute: (operation: Parameters<SafeExecutor["execute"]>[0]) => executor.execute(operation),
      localWriteStillMatches: async (entry: LocalEntry) => {
        const observed = await this.app.vault.adapter.stat(entry.key);
        return Boolean(observed && observed.size === entry.size && observed.mtime === entry.mtime);
      },
      observeConflicts: (conflicts: Array<Extract<SyncOperation, { type: "conflict" }>>, observations: CycleObservations) => this.conflictObservations(conflicts, observations.local, observations.remote, observations.previous),
      observeConverged: (operations: Array<Extract<SyncOperation, { type: "noop" }>>, observations: CycleObservations) => this.recordConvergedMergeBases(operations, observations.local, observations.remote, observations.previous, channel),
    };
  }

  /** Gathers identity inputs for conflicted keys from the maps the planner already received. */
  private conflictObservations(conflicts: Array<Extract<SyncOperation, { type: "conflict" }>>, local: Map<string, LocalEntry>, remote: Map<string, RemoteEntry>, previous: Map<string, PreviousEntry>): ConflictObservation[] {
    const output: ConflictObservation[] = [];
    for (const conflict of conflicts) {
      const observedLocal = local.get(conflict.key), observedRemote = remote.get(conflict.key);
      // Delete conflicts deliberately have an absent side. Preserve the effective deletion identity
      // separately so an old resolver choice cannot apply after a path is recreated or re-deleted.
      if (isRemoteDeleted(observedRemote)) { if (observedLocal) output.push({ key: conflict.key, previous: previous.get(conflict.key), observedLocal, observedRemoteDeletion: observedRemote.deleted }); }
      else if (observedLocal || observedRemote) output.push({ key: conflict.key, previous: previous.get(conflict.key), observedLocal, observedRemote });
    }
    return output;
  }

  /**
   * Backfills a merge base only after the planner proved the exact local/remote pair already
   * converged. Conflicts are deliberately absent from this path: neither divergent side is a base.
   */
  private async recordConvergedMergeBases(operations: Array<Extract<SyncOperation, { type: "noop" }>>, local: Map<string, LocalEntry>, remote: Map<string, RemoteEntry>, previous: Map<string, PreviousEntry>, channel: string | undefined): Promise<void> {
    if (!channel) return;
    const startedAt = Date.now();
    const candidates: MergeBaseInput[] = [];
    for (const operation of operations) {
      const localVersion = local.get(operation.key), remoteVersion = remote.get(operation.key), baseline = previous.get(operation.key);
      if (!localVersion || !remoteVersion || !baseline?.local || !baseline.remote?.etag) continue;
      if (baseline.local.size !== localVersion.size || baseline.local.mtime !== localVersion.mtime || baseline.remote.etag !== remoteVersion.etag) continue;
      candidates.push({ path: operation.key, baseline: { localVersion, remoteETag: remoteVersion.etag } });
    }
    const existing = await this.conflictStores.getMany(channel, candidates.map((candidate) => candidate.path));
    const missing = candidates.filter((candidate) => !existing.has(candidate.path));
    await recordMergeBaseBatch(this.app.vault, channel, this.conflictStores, missing);
    this.debug(`merge-base candidates=${candidates.length} missing=${missing.length} durationMs=${Date.now() - startedAt}`);
  }

  /**
   * The channel this device's R2 namespace maps to. Derived on demand from the R2 identity rather
   * than stored, so it follows a namespace change and cannot drift from the baseline's own identity.
   */
  private currentChannel(): string | undefined { return this.resolvedChannel; }

  /** Channel derivation is a digest, so it is resolved once per cycle and cached for sync access. */
  private async resolveChannel(): Promise<string | undefined> {
    if (!this.settings.endpoint.trim() || !this.settings.bucket.trim()) { this.resolvedChannel = undefined; return undefined; }
    try { this.resolvedChannel = await deriveRemoteChangeChannel({ endpoint: this.settings.endpoint, bucket: this.settings.bucket, remotePrefix: this.settings.remotePrefix }); }
    catch { this.resolvedChannel = undefined; }
    return this.resolvedChannel;
  }

  private async openConflictResolver(): Promise<void> {
    const coordinator = this.coordinator;
    if (!coordinator) return;
    // A status-bar count may have come from an earlier cycle. Re-observe before opening the modal
    // so its contents are built from the same current local/remote/baseline facts as the count.
    // This path is read-only except for conflict metadata and resolution proposals; it never writes
    // a Vault file or an R2 object.
    try { await this.refreshConflictsForResolver(); }
    catch { this.debug("conflict resolver refresh failed"); }
    new ConflictResolverModal(this.app, {
      // Only decisions, never evidence: an automatically settled divergence stays recorded but is not
      // offered here, because asking the user to review a merge the engine already made is the
      // interruption this behaviour exists to remove.
      list: () => this.pendingConflicts(),
      propose: (intent) => coordinator.propose(intent),
      debug: (message) => this.debug(message),
    }).open();
  }

  private async refreshConflictsForResolver(): Promise<void> {
    const coordinator = this.coordinator;
    if (!coordinator) return;
    const channel = await this.resolveChannel();
    if (!channel) return;
    coordinator.setChannel(channel);
    const settings: R2SyncSettings = { ...this.settings, ignoredPaths: [...this.settings.ignoredPaths] };
    const filter = createVaultPathFilter(settings);
    const identity = remoteIdentity(settings);
    const local = Platform.isAndroidApp ? await scanLocalAdapterMetadata(this.app.vault, filter) : scanLocal(this.app.vault, filter);
    const [remote, stored] = await Promise.all([scanRemote(new SignedR2ListClient(settings), filter), this.stateStore.loadAll()]);
    const previous = new Map([...stored].filter(([key, entry]) => !filter.ignores(key) && entry.ignorePolicy === ignorePolicyFingerprint(settings) && entry.remoteIdentity?.endpoint === identity.endpoint && entry.remoteIdentity.bucket === identity.bucket && entry.remoteIdentity.remotePrefix === identity.remotePrefix));
    // Deliberately do not consume a pending intent here. The command is rebuilding user-visible
    // observations; the scheduler remains the only place that executes the resolution.
    const plan = buildSyncPlan(local, remote, previous);
    const conflicts = plan.operations.filter((entry): entry is Extract<SyncOperation, { type: "conflict" }> => entry.type === "conflict");
    await coordinator.handleConflicts(this.conflictObservations(conflicts, local, remote, previous));
    await this.refreshConflictStatus();
  }

  /**
   * Conflict handling runs after every cycle, including one with no conflicts.
   *
   * The empty case matters: it is how the coordinator learns that a conflict it recorded is no longer
   * active and must be dropped. The channel is re-derived here so records and intents always belong to
   * the namespace the cycle that produced them was built for.
   */
  private async handleConflicts(conflicts: ConflictObservation[]): Promise<void> {
    const coordinator = this.coordinator;
    if (!coordinator) return;
    const channel = await this.resolveChannel();
    if (!channel) return;
    coordinator.setChannel(channel);
    await coordinator.handleConflicts(conflicts);
    await this.refreshConflictStatus();
  }

  /** Retires a conflict record and its intent once a resolution has actually applied. */
  private async clearResolution(conflictId: string, path: string): Promise<void> {
    const channel = this.currentChannel();
    if (!channel) return;
    this.coordinator?.setChannel(channel);
    this.debug(`resolution applied path-hash=${conflictId.slice(0, 8)}`);
    // Written before the record and its intent are retired, because together they are the only
    // evidence of what the two sides were and what was decided.
    await this.recordResolutionHistory(channel, conflictId, path);
    await this.coordinator?.clear(conflictId, path);
    await this.refreshConflictStatus();
  }

  /**
   * Records what a resolution actually did, including the versions it replaced.
   *
   * Only reached from `onResolutionApplied`, so an entry exists only for something that landed: a
   * merge that was merely proposed, or a resolution that turned out stale, leaves no history and is
   * not claimed. Every snapshot here is what makes the automation recoverable.
   */
  private async recordResolutionHistory(channel: string, conflictId: string, path: string): Promise<void> {
    try {
      const record = (await this.coordinator?.list() ?? []).find((candidate) => candidate.conflictId === conflictId);
      if (!record) return;
      const intent = await this.coordinator?.intentFor(path);
      const resolutionType = intent?.conflictId === conflictId ? intent.type : "unknown";
      const result = this.resolutionResultText(record, intent);
      if (result === undefined) return;

      const base = record.snapshot.baseAvailable && record.snapshot.base !== undefined ? await snapshotOf(record.snapshot.base) : undefined;
      const localBefore = record.snapshot.local === undefined ? undefined : await snapshotOf(record.snapshot.local);
      const remoteBefore = record.snapshot.remote === undefined ? undefined : await snapshotOf(record.snapshot.remote);
      const shared = { channel, path, timestamp: Date.now(), ...(base ? { base } : {}), ...(localBefore ? { localBefore } : {}), ...(remoteBefore ? { remoteBefore } : {}), result };
      const entry = isAutoResolved(record.autoMergeStatus)
        ? await mergeHistoryEntry({
            ...shared,
            type: record.autoMergeStatus === "handoff" ? "handoff-auto-merge" : "clean-auto-merge",
            metadata: { mergeReason: record.reason, ...handoffHistoryMetadata(record.handoff) },
          })
        : await manualHistoryEntry({ ...shared, conflictId, resolutionType });
      await this.history.record(entry);
      this.debug(`history recorded type=${entry.type} path-digest=${pathDigest(path)}`);
    } catch { this.debug("history write failed"); }
  }

  /**
   * The text a resolution left behind. A deletion has no result text, and records an empty one rather
   * than inventing content for it; its before-snapshots are what make it recoverable.
   */
  private resolutionResultText(record: ConflictRecord, intent: ResolutionIntent | undefined): string | undefined {
    if (intent?.merged) return intent.merged.content;
    switch (intent?.type) {
      case "keep-local": return record.snapshot.local ?? "";
      case "keep-remote": return record.snapshot.remote ?? "";
      case "accept-remote-delete":
      case "accept-local-delete": return "";
      default: return record.snapshot.draft ?? record.snapshot.local;
    }
  }

  /**
   * The conflicts that actually need the user. Anything the divergence policy settled is recorded as
   * evidence but is not work, so it is neither counted nor shown: the badge is only for real decisions.
   */
  private async pendingConflicts(): Promise<ConflictRecord[]> {
    const records = (await this.coordinator?.list()) ?? [];
    return records.filter((record) => !isAutoResolved(record.autoMergeStatus));
  }

  /**
   * Republishes the status bar. Deliberately silent: a conflict is reported by the badge alone, and the
   * user opens the resolver when they choose to. Proactive notices were the thing this behaviour was
   * asked to stop, since a note that keeps diverging would otherwise interrupt on every cycle.
   */
  private async refreshConflictStatus(): Promise<void> {
    this.lastConflictCount = (await this.pendingConflicts()).length;
    this.scheduler?.refreshStatus();
  }

  /**
   * Makes a historical snapshot current again.
   *
   * This is the one write the history UI performs, and it is deliberately the *least* powerful one: the
   * snapshot becomes this device's working version, and the ordinary exact-path pipeline then decides
   * what happens to it. Nothing here touches a baseline, an ETag or a generation, so a remote that has
   * moved on since produces the normal merge or conflict rather than an overwrite — a restore can never
   * be a way around the safety checks.
   */
  private async restoreFromHistory(input: { path: string; content: string; sourceHistoryId: string }): Promise<void> {
    const channel = this.currentChannel();
    if (!channel) throw new Error("no channel is configured for this vault");
    this.debug(`history restore requested path-digest=${pathDigest(input.path)} sourceHistoryId=${input.sourceHistoryId}`);
    const file = this.app.vault.getFileByPath(input.path);
    const previousText = file ? await this.app.vault.read(file) : undefined;
    if (file) await this.app.vault.modify(file, input.content);
    else {
      // A restore into a file that no longer exists has to recreate it, so its folders may be gone too.
      // Checked rather than ignored: a silent failure here would look like a restore that landed.
      const prepared = await ensureParentFolders(this.app.vault, input.path);
      if (!prepared.ok) throw new Error(`restore target folder unavailable (${prepared.reason})`);
      await this.app.vault.create(input.path, input.content);
    }
    try {
      // Recorded after the write, so a failed write leaves no entry claiming it happened.
      await this.history.record(await restoreHistoryEntry({
        channel, path: input.path, timestamp: Date.now(),
        sourceHistoryId: input.sourceHistoryId,
        previousCurrent: await snapshotOf(previousText ?? ""),
        result: input.content,
      }));
      this.debug(`history recorded type=restore path-digest=${pathDigest(input.path)}`);
    } catch { this.debug("history write failed"); }
    this.scheduler?.markLocalPaths([input.path], (key) => createVaultPathFilter(this.settings).ignores(key));
    this.scheduler?.requestReconcile("manual");
  }
  private safeConnectionDiagnostic(error: unknown): string {
    if (!(error instanceof Error) || !error.message) return "unknown error";
    return error.message
      .replaceAll(this.settings.accessKeyId, "[access-key]")
      .replaceAll(this.settings.secretAccessKey, "[secret]")
      .replace(/AWS4-HMAC-SHA256[^\s]*/gi, "[authorization]")
      .replace(/https?:\/\/[^\s]+/gi, "[endpoint]")
      .replace(/\s+/g, " ")
      .slice(0, 180);
  }

  async testConnection(): Promise<void> {
    try { const remote = await scanRemote(this.client(), createVaultPathFilter(this.settings)); new Notice(`R2 connection succeeded: ${remote.size} sync-eligible object(s) visible.`); }
    catch (error) {
      const diagnostic = this.safeConnectionDiagnostic(error);
      console.error("[Mineral Obsidian Sync] R2 connection failed", diagnostic);
      new Notice(`R2 connection failed: ${diagnostic}`);
    }
  }

  async inspectSyncState(): Promise<void> {
    this.activeAnalysis?.abort();
    const controller = new AbortController(); this.activeAnalysis = controller;
    this.showBusyStatus("Analyzing sync state…");
    try {
      const filter = createVaultPathFilter(this.settings);
      const ignorePolicy = ignorePolicyFingerprint(this.settings);
      const local = scanLocal(this.app.vault, filter);
      const [remote, storedPrevious] = await Promise.all([scanRemote(this.client(), filter), this.stateStore.loadAll()]);
      const identity = remoteIdentity(this.settings);
      // Legacy and other-namespace baselines must never infer deletion in this namespace.
      const previous = new Map([...storedPrevious].filter(([key, entry]) => !filter.ignores(key) && entry.ignorePolicy === ignorePolicy && entry.remoteIdentity?.endpoint === identity.endpoint && entry.remoteIdentity.bucket === identity.bucket && entry.remoteIdentity.remotePrefix === identity.remotePrefix));
      const client = this.client();
      const result = await buildBootstrapResult(local, remote, previous, {
        readLocal: (_key, expected) => readStableLocalBytes(this.app.vault, expected),
        readRemote: (key, expected) => client.getObject(key, { ifMatch: expected.etag }),
      }, controller.signal, identity, ignorePolicy);
      if (controller.signal.aborted) return;
      await this.stateStore.saveVerified(result.baselineCandidates);
      const totals = Object.fromEntries(result.plan.operations.map((entry) => [entry.type, result.plan.operations.filter((candidate) => candidate.type === entry.type).length]));
      this.debug(`local=${local.size} remote=${remote.size} previous=${previous.size} plan=${JSON.stringify(totals)} bootstrap=${JSON.stringify(result.diagnostics)}`);
      new DryRunModal(this.app, result.plan, { local: local.size, remote: remote.size, previous: previous.size, ...result.diagnostics }).open();
      // The status bar goes back to the scheduler's own state in the `finally` below; the inspector's
      // own conclusion is a dry run, and a dry run does not change what is synced.
    } catch (error) {
      console.error("[Mineral Obsidian Sync] sync inspection failed", error instanceof Error ? error.message : "unknown error");
      this.showErrorStatus("Sync inspection failed");
      new Notice("Sync inspection failed. Check settings, network, and R2 access.");
    } finally { if (this.activeAnalysis === controller) this.activeAnalysis = undefined; this.scheduler?.refreshStatus(); }
  }
}

/**
 * The handoff policy facts, in the shape history stores them.
 *
 * Everything is copied from what the policy actually measured, so an entry never claims a separation
 * or a size the decision did not have. `reason` is the exception: on the record it explains one
 * handoff, while the entry's `mergeReason` explains the event, so the caller supplies that field.
 */
function handoffHistoryMetadata(facts: HandoffEvidence | undefined): SyncHistoryMetadata {
  if (!facts) return {};
  return {
    ...(facts.branchSeparationMs === undefined ? {} : { branchSeparationMs: facts.branchSeparationMs }),
    ...(facts.branchAgeMs === undefined ? {} : { branchAgeMs: facts.branchAgeMs }),
    ...(facts.localDeltaBytes === undefined ? {} : { localDeltaBytes: facts.localDeltaBytes }),
    ...(facts.remoteDeltaBytes === undefined ? {} : { remoteDeltaBytes: facts.remoteDeltaBytes }),
    ...(facts.hunkCount === undefined ? {} : { hunkCount: facts.hunkCount }),
    ...(facts.order === undefined ? {} : { order: facts.order }),
  };
}


