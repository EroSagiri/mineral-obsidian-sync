import { MarkdownView, Menu, Notice, Platform, Plugin, TFolder, type TFile } from "obsidian";
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
import { presentSyncStatus, renderSyncStatus, SYNC_STATUS_CSS, SYNC_STATUS_ICON, type SyncStatusPresentation } from "./ui/sync-status";
import { isRemoteDeleted, type LocalEntry, type PreviousEntry, type RemoteEntry, type RemoteIdentity, type SyncOperation } from "./sync/types";
import type { ConflictObservation, ResultCounts, SchedulerState } from "./scheduler/types";

type CycleObservations = { local: Map<string, LocalEntry>; remote: Map<string, RemoteEntry>; previous: Map<string, PreviousEntry> };

const ANDROID_LOCAL_DRIFT_INTERVAL_MS = 15_000;
const ANDROID_EDITOR_SAVE_DEBOUNCE_MS = 500;
const INTEGRITY_RECONCILE_TICK_MS = 60_000;
/**
 * Above this many drifted paths the drift is reported as it stands, without consulting the baseline:
 * a bulk change is never this plugin's own download, and one IndexedDB read per path would be waste.
 */
const ANDROID_DRIFT_BASELINE_LIMIT = 25;
/** A markdown note this large is not an editing surface worth re-reading on every drift tick. */
const ANDROID_BUFFER_COMPARISON_MAX_BYTES = 2_000_000;
/** The all-zero result counts a scheduler reports before its first cycle. */
const NO_RESULTS: ResultCounts = { applied: 0, stale: 0, failed: 0, unresolved: 0, blocked: 0, partial: 0, conflict: 0, noop: 0 };

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
    this.addCommand({ id: "r2-sync-history", name: "Mineral Sync: Open Sync History", callback: () => this.openSyncHistory() });
    // Development-only diagnostics: never registered, and not even bundled, in production.
    if (__DEV__) {
      registerDevelopmentSelfTests({
        app: this.app,
        settings: this.settings,
        pluginDir: this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
        addCommand: (command) => this.addCommand(command),
        setStatus: (text) => this.showBusyStatus(text),
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
      onResolutionApplied: (conflictId, path) => this.clearResolution(conflictId, path),
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
    this.gateway?.stop();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.scheduler?.configChanged();
    // A settings save can change the channel, the endpoint, or the token; all three must reconnect,
    // and the channel cursor is reloaded before any new socket can deliver a generation.
    await this.applyGatewayConfig(false);
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
  /** Debug-only operational telemetry: intentionally no paths, content, credentials, or signed headers. */
  private debug(message: string): void { if (this.settings.debugLogging) console.log(`[Mineral Obsidian Sync] ${message}`); }

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
    }));
    this.maybePruneTombstones(state);
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
    if ((this.statusPresentation?.action ?? "sync-now") === "resolve-conflicts") { void this.openConflictResolver(); return; }
    this.scheduler?.requestReconcile("manual");
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
    this.debug(`status details ${lines.join(" · ")}`);
    new Notice(`Mineral Sync — ${lines.join("\n")}`);
  }
  private registerVaultListeners(): void {
    const mark = (path: string) => this.scheduler?.markLocalPaths([path], (key) => createVaultPathFilter(this.settings).ignores(key));
    this.registerEvent(this.app.vault.on("create", (file) => { if (!(file instanceof TFolder)) mark(file.path); }));
    this.registerEvent(this.app.vault.on("modify", (file) => { if (!(file instanceof TFolder)) void this.markUnlessOwnEditorWrite(file.path); }));
    // A deleted folder cannot be reliably distinguished after removal; treating it as dirty is the safe side.
    this.registerEvent(this.app.vault.on("delete", (file) => mark(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { if (!(file instanceof TFolder)) this.scheduler?.markLocalPaths([oldPath, file.path], (key) => createVaultPathFilter(this.settings).ignores(key)); }));
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
    this.scheduler?.markLocalPaths([path], (key) => createVaultPathFilter(this.settings).ignores(key));
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
      buildPlan: (local: Map<string, LocalEntry>, remote: Map<string, RemoteEntry>, previous: Map<string, PreviousEntry>) => buildSyncPlan(local, remote, previous, this.coordinator?.resolutions()),
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
      else if (previous.has(conflict.key) && (observedLocal || observedRemote)) output.push({ key: conflict.key, previous: previous.get(conflict.key), observedLocal, observedRemote });
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
