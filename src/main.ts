import { Notice, Platform, Plugin, TFolder, type TFile } from "obsidian";
import { scanLocal, scanLocalAdapterMetadata } from "./local/scan-local";
import { readStableLocalBytes } from "./local/read-local";
import { remoteIdentity, SignedR2ListClient } from "./remote/r2-client";
import { scanRemote } from "./remote/scan-remote";
import { DEFAULT_SETTINGS, R2SyncSettingTab, type R2SyncSettings } from "./settings";
import { IndexedDbStateStore } from "./state/state-store";
import { buildBootstrapResult } from "./bootstrap/bootstrap";
import { DryRunModal } from "./ui/dry-run-modal";
import { createVaultPathFilter, ignorePolicyFingerprint } from "./sync/ignore";
import { registerDevelopmentSelfTests } from "./dev/self-test-command";
import { SafeExecutor, type VaultFileRemover } from "./sync/executor";
import { buildSyncPlan } from "./sync/planner";
import { SyncScheduler } from "./scheduler/scheduler";
import { changedLocalKeys } from "./scheduler/mobile-local-drift";
import { GatewayClient, type GatewayClientDiagnostics } from "./gateway/client";
import { RequestUrlGatewayTransport } from "./gateway/transport";
import { IndexedDbGatewayCursorStore } from "./gateway/cursor-store";
import { resolveGatewayConfig } from "./gateway/config";
import type { GatewayConfigState } from "./gateway/types";
import { gatewayConnectionConfig } from "./gateway/types";
import type { LocalEntry, RemoteIdentity } from "./sync/types";
import type { ResultCounts, SchedulerState } from "./scheduler/types";

const ANDROID_LOCAL_DRIFT_INTERVAL_MS = 15_000;

export default class R2PersonalSyncPlugin extends Plugin {
  settings: R2SyncSettings = { ...DEFAULT_SETTINGS };
  private readonly stateStore = new IndexedDbStateStore();
  private readonly gatewayCursors = new IndexedDbGatewayCursorStore();
  private activeAnalysis?: AbortController;
  private statusBar?: HTMLElement;
  private scheduler?: SyncScheduler;
  private gateway?: GatewayClient;
  private gatewayConfig: GatewayConfigState = { kind: "disabled" };
  private androidLocalSnapshot?: Map<string, LocalEntry>;
  private androidLocalDriftPollRunning = false;

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
    // Development-only diagnostics: never registered, and not even bundled, in production.
    if (__DEV__) {
      registerDevelopmentSelfTests({
        app: this.app,
        settings: this.settings,
        pluginDir: this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
        addCommand: (command) => this.addCommand(command),
        setStatus: (text) => this.setStatus(text),
      });
    }
    this.statusBar = this.addStatusBarItem();
    this.setStatus("✓ idle");
    this.gateway = new GatewayClient(
      () => gatewayConnectionConfig(this.settings),
      new RequestUrlGatewayTransport(),
      this.gatewayCursors,
      {
        // A Gateway announcement is only ever a reason to reconcile. It carries no path, no
        // operation, and no instruction; the planner still decides everything.
        onAnnounced: (generation, source) => {
          this.debug(`gateway announce generation=${generation} source=${source}`);
          this.scheduler?.requestReconcile("remote-change");
        },
        onStatusChanged: () => this.scheduler?.refreshStatus(),
      },
      { openSocket: (url) => new WebSocket(url), now: () => Date.now(), timerSet: (delay, callback) => window.setTimeout(callback, delay), timerClear: (handle) => window.clearTimeout(handle as number), debug: (message) => this.debug(message) },
    );    this.scheduler = new SyncScheduler({
      visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
      captureCycle: () => this.captureSchedulerCycle(),
      onStatus: (state, counts) => this.setSchedulerStatus(state, counts),
      debug: (message) => this.debug(message),
      remoteChange: {
        hasPending: () => this.gateway?.hasPending() ?? false,
        readGeneration: () => this.gateway?.readGeneration() ?? Promise.resolve({ ok: false as const, kind: "misconfigured" }),
        confirmReconciled: async (generation) => { await this.gateway?.confirmReconciled(generation); },
        notifyRemoteDirty: () => this.gateway?.markRemoteDirty() ?? Promise.resolve({ ok: false as const, kind: "misconfigured" }),
      },
    });
    this.app.workspace.onLayoutReady(() => {
      this.registerVaultListeners();
      this.registerAndroidLocalDriftDetector();
      this.registerDomEvent(document, "visibilitychange", () => this.onVisibilityChanged(document.visibilityState !== "hidden"));
      this.scheduler?.requestReconcile("startup");
      void this.applyGatewayConfig(true);
    });
  }

  onunload(): void {
    this.activeAnalysis?.abort();
    this.scheduler?.stop();
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
    this.scheduler?.visibilityChanged(visible);
    // Phone resume is the one moment a device learns what happened while it was away; the socket is
    // closed while hidden so no background reconnect storm can occur.
    this.gateway?.setVisible(visible);
  }
  private client(): SignedR2ListClient { return new SignedR2ListClient(this.settings); }
  /** Debug-only operational telemetry: intentionally no paths, content, credentials, or signed headers. */
  private debug(message: string): void { if (this.settings.debugLogging) console.log(`[Mineral Obsidian Sync] ${message}`); }
  private setStatus(text: string): void { this.statusBar?.setText(`Mineral Sync ${text}`); }
  private setSchedulerStatus(state: SchedulerState, counts: ResultCounts): void {
    if (state === "running") return this.setStatus("… syncing");
    if (state === "debouncing" || state === "rerun-pending") return this.setStatus("… pending");
    if (state === "blocked-by-auth") return this.setStatus("○ auth blocked");
    if (counts.conflict) return this.setStatus(`! conflicts (${counts.conflict})`);
    if (counts.unresolved || counts.failed) return this.setStatus("○ offline/error");
    this.setStatus("✓ idle");
  }
  private registerVaultListeners(): void {
    const mark = (path: string) => this.scheduler?.markLocalPaths([path], (key) => createVaultPathFilter(this.settings).ignores(key));
    this.registerEvent(this.app.vault.on("create", (file) => { if (!(file instanceof TFolder)) mark(file.path); }));
    this.registerEvent(this.app.vault.on("modify", (file) => { if (!(file instanceof TFolder)) mark(file.path); }));
    // A deleted folder cannot be reliably distinguished after removal; treating it as dirty is the safe side.
    this.registerEvent(this.app.vault.on("delete", (file) => mark(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { if (!(file instanceof TFolder)) this.scheduler?.markLocalPaths([oldPath, file.path], (key) => createVaultPathFilter(this.settings).ignores(key)); }));
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
      const next = await scanLocalAdapterMetadata(this.app.vault, createVaultPathFilter(this.settings));
      const previous = this.androidLocalSnapshot;
      this.androidLocalSnapshot = next;
      if (!previous) return;
      const changed = changedLocalKeys(previous, next);
      if (!changed.length) return;
      this.debug(`android local-drift entries=${changed.length}`);
      this.scheduler?.markLocalPaths(changed, () => false);
    } catch {
      // A transient Android storage read is not a sync failure and must not trigger remote work.
      this.debug("android local-drift metadata-scan-failed");
    } finally { this.androidLocalDriftPollRunning = false; }
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
    const client = new SignedR2ListClient(settings);
    const executor = new SafeExecutor(this.app.vault, client, this.stateStore, identity, ignorePolicy, this.vaultFileRemover());
    return {
      // Android may retain stale TFile.stat after an omitted Vault event. The adapter is the
      // authoritative local metadata source for both planning and the foreground drift fallback.
      scanLocal: () => Platform.isAndroidApp ? scanLocalAdapterMetadata(this.app.vault, filter) : scanLocal(this.app.vault, filter),
      scanRemote: () => scanRemote(client, filter),
      loadPrevious: () => this.stateStore.loadAll(),
      filterPrevious: (storedPrevious: Awaited<ReturnType<IndexedDbStateStore["loadAll"]>>) => new Map([...storedPrevious].filter(([key, entry]) => !filter.ignores(key) && entry.ignorePolicy === ignorePolicy && entry.remoteIdentity?.endpoint === identity.endpoint && entry.remoteIdentity.bucket === identity.bucket && entry.remoteIdentity.remotePrefix === identity.remotePrefix)),
      buildPlan: buildSyncPlan,
      execute: (operation: Parameters<SafeExecutor["execute"]>[0]) => executor.execute(operation),
    };
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
    this.setStatus("… analyzing");
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
      this.setStatus(result.plan.operations.some((entry) => entry.type === "conflict") ? "! conflicts" : "✓ inspected");
    } catch (error) {
      console.error("[Mineral Obsidian Sync] sync inspection failed", error instanceof Error ? error.message : "unknown error");
      this.setStatus("○ offline/error");
      new Notice("Sync inspection failed. Check settings, network, and R2 access.");
    } finally { if (this.activeAnalysis === controller) this.activeAnalysis = undefined; this.scheduler?.refreshStatus(); }
  }
}
