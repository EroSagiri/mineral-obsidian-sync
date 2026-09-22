import { MarkdownView, Notice, Platform, Plugin, TFolder, type TFile } from "obsidian";
import { scanLocal, scanLocalAdapterMetadata } from "./local/scan-local";
import { readStableLocalBytes } from "./local/read-local";
import { remoteIdentity, SignedR2ListClient } from "./remote/r2-client";
import { RemoteHttpError } from "./remote/errors";
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
import { deriveRemoteChangeChannel } from "@mineral/sync-core/channel";
import type { RemoteChange } from "@mineral/sync-core/sync-change";
import { canonicalKey } from "./sync/path";
import { IndexedDbConflictStores } from "./conflict/stores";
import { createMergeBaseRecorder, recordMergeBaseBatch, type MergeBaseInput } from "./conflict/merge-base";
import { ConflictCoordinator } from "./conflict/coordinator";
import { ConflictResolverModal } from "./ui/conflict-resolver-modal";
import { isRemoteDeleted, type LocalEntry, type PreviousEntry, type RemoteEntry, type RemoteIdentity, type SyncOperation } from "./sync/types";
import type { ConflictObservation, ResultCounts, SchedulerState } from "./scheduler/types";

type CycleObservations = { local: Map<string, LocalEntry>; remote: Map<string, RemoteEntry>; previous: Map<string, PreviousEntry> };

const ANDROID_LOCAL_DRIFT_INTERVAL_MS = 15_000;
const ANDROID_EDITOR_SAVE_DEBOUNCE_MS = 500;
const INTEGRITY_RECONCILE_TICK_MS = 60_000;

export default class R2PersonalSyncPlugin extends Plugin {
  settings: R2SyncSettings = { ...DEFAULT_SETTINGS };
  private readonly stateStore = new IndexedDbStateStore();
  private readonly gatewayCursors = new IndexedDbGatewayCursorStore();
  private readonly conflictStores = new IndexedDbConflictStores();
  private activeAnalysis?: AbortController;
  private statusBar?: HTMLElement;
  private scheduler?: SyncScheduler;
  private gateway?: GatewayClient;
  private coordinator?: ConflictCoordinator;
  private gatewayConfig: GatewayConfigState = { kind: "disabled" };
  private androidLocalSnapshot?: Map<string, LocalEntry>;
  private androidLocalDriftPollRunning = false;
  /** One quiet-period save per edited path; Android can otherwise defer Vault modify until view close. */
  private readonly androidEditorSaveTimers = new Map<string, number>();
  /** Conflict ids already announced, so a Notice is shown once per conflict rather than per cycle. */
  private readonly announcedConflicts = new Set<string>();
  private lastConflictCount = 0;
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
      onResolutionApplied: (conflictId, path) => this.clearResolution(conflictId, path),      remoteChange: {
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
    this.scheduler?.visibilityChanged(visible);
    // Phone resume is the one moment a device learns what happened while it was away; the socket is
    // closed while hidden so no background reconnect storm can occur.
    this.gateway?.setVisible(visible);
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
  private setStatus(text: string): void { this.statusBar?.setText(`Mineral Sync ${text}`); }
  private setSchedulerStatus(state: SchedulerState, counts: ResultCounts): void {
    if (state === "running") return this.setStatus("… syncing");
    if (state === "debouncing" || state === "rerun-pending") return this.setStatus("… pending");
    if (state === "blocked-by-auth") return this.setStatus("○ auth blocked");
    // A plan-level conflict is only a detection. The Resolve command can act only on the durable
    // record that the coordinator established from it, so the status bar must never advertise a
    // number the resolver cannot actually display.
    if (this.lastConflictCount) return this.setStatus(`! conflicts (${this.lastConflictCount})`);
    if (counts.conflict) return this.setStatus("○ conflict state unavailable");
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
    if (Platform.isAndroidApp) {
      this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
        if (info instanceof MarkdownView && info.file) this.scheduleAndroidEditorSave(info);
      }));
    }
  }

  /**
   * Obsidian Android can retain edits in the active MarkdownView until that view loses focus. Save
   * the view after a short quiet period so the normal Vault event and normal sync pipeline can see
   * it. The editor buffer is never uploaded directly: after save, SafeExecutor rereads stable Vault
   * bytes and still applies the usual remote preconditions.
   */
  private scheduleAndroidEditorSave(view: MarkdownView): void {
    const path = view.file?.path;
    if (!path || createVaultPathFilter(this.settings).ignores(path)) return;
    const previous = this.androidEditorSaveTimers.get(path);
    if (previous !== undefined) window.clearTimeout(previous);
    const handle = window.setTimeout(() => {
      this.androidEditorSaveTimers.delete(path);
      void this.flushAndroidEditorSave(view, path);
    }, ANDROID_EDITOR_SAVE_DEBOUNCE_MS);
    this.androidEditorSaveTimers.set(path, handle);
  }

  private async flushAndroidEditorSave(view: MarkdownView, path: string): Promise<void> {
    if (document.visibilityState === "hidden" || view.file?.path !== path) return;
    try {
      await view.save();
      // `save()` normally emits Vault modify. Mark explicitly as well so a mobile adapter that
      // delays that event still gets the low-latency editor-change reconciliation.
      this.scheduler?.markLocalPaths([path], (key) => createVaultPathFilter(this.settings).ignores(key), "editor-change");
      this.debug("android editor-change saved");
    } catch {
      // A view may close or be replaced while its debounce is pending. The ordinary Vault listener
      // remains the fallback; this must not turn an editor lifecycle race into a sync failure.
      this.debug("android editor-change save failed");
    }
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
    const client = new SignedR2ListClient(settings, undefined, undefined, undefined, (message) => this.debug(message));
    const channel = this.currentChannel();
    const executor = new SafeExecutor(this.app.vault, client, this.stateStore, identity, ignorePolicy, this.vaultFileRemover(), channel ? createMergeBaseRecorder(this.app.vault, channel, this.conflictStores) : undefined, (message) => this.debug(message));
    // Scanned once per cycle and shared by planning and conflict observation, so both see exactly the
    // same observations and no second scan can disagree with the planner's inputs.
    return {
      // Android may retain stale TFile.stat after an omitted Vault event. The adapter is the
      // authoritative local metadata source for both planning and the foreground drift fallback.
      scanLocal: () => Platform.isAndroidApp ? scanLocalAdapterMetadata(this.app.vault, filter) : scanLocal(this.app.vault, filter),
      scanRemote: () => scanRemote(client, filter, (message) => this.debug(message)),
      incrementalObservations: async (changes: RemoteChange[]) => {
        const keys = new Set<string>();
        const remote = new Map<string, RemoteEntry>();
        for (const change of changes) {
          if (change.op === "rename") { keys.add(canonicalKey(change.from)); keys.add(canonicalKey(change.to)); }
          else keys.add(canonicalKey(change.path));
        }
        for (const change of changes) {
          if (change.op === "delete") { remote.delete(canonicalKey(change.path)); continue; }
          if (change.op === "rename") {
            remote.delete(canonicalKey(change.from));
            const key = canonicalKey(change.to);
            if (!filter.ignores(key)) remote.set(key, await client.headObject(key, change.etag ? { ifMatch: change.etag } : {}));
            continue;
          }
          const key = canonicalKey(change.path);
          if (filter.ignores(key)) continue;
          // A complete put fact avoids another request. Any omitted field is intentionally filled by
          // one exact HEAD rather than guessed from wall-clock time or a stale local baseline.
          const modified = change.modified ? Date.parse(change.modified) : NaN;
          if (change.etag && typeof change.size === "number" && Number.isFinite(modified)) remote.set(key, { key, etag: change.etag, size: change.size, lastModified: modified });
          else remote.set(key, await client.headObject(key, change.etag ? { ifMatch: change.etag } : {}));
        }
        const local = new Map<string, LocalEntry>();
        for (const key of keys) {
          if (filter.ignores(key)) continue;
          const stat = await this.app.vault.adapter.stat(key);
          if (stat) local.set(key, { key, size: stat.size, mtime: stat.mtime });
        }
        const all = await this.stateStore.loadAll();
        const previous = new Map([...all].filter(([key, entry]) => keys.has(key) && !filter.ignores(key) && entry.ignorePolicy === ignorePolicy && entry.remoteIdentity?.endpoint === identity.endpoint && entry.remoteIdentity.bucket === identity.bucket && entry.remoteIdentity.remotePrefix === identity.remotePrefix));
        return { local, remote, previous };
      },
      localIncrementalObservations: async (keys: string[]) => {
        const local = new Map<string, LocalEntry>();
        const remote = new Map<string, RemoteEntry>();
        for (const key of keys) {
          const stat = await this.app.vault.adapter.stat(key);
          if (stat) local.set(key, { key, size: stat.size, mtime: stat.mtime });
          try {
            // An exact HEAD is sufficient for create/modify/delete planning. A logically deleted
            // predecessor remains physically readable at the same ETag, which deliberately makes
            // a repeated local delete idempotent and a later local modification a conditional revive.
            remote.set(key, await client.headObject(key));
          } catch (error) {
            if (!(error instanceof RemoteHttpError && error.status === 404)) throw error;
          }
        }
        const all = await this.stateStore.loadAll();
        const previous = new Map([...all].filter(([key, entry]) => keys.includes(key) && !filter.ignores(key) && entry.ignorePolicy === ignorePolicy && entry.remoteIdentity?.endpoint === identity.endpoint && entry.remoteIdentity.bucket === identity.bucket && entry.remoteIdentity.remotePrefix === identity.remotePrefix));
        return { local, remote, previous };
      },
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
      list: () => coordinator.list(),
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
    await this.coordinator?.clear(conflictId, path);
    await this.refreshConflictStatus();
  }

  /** Announces each newly seen conflict exactly once and republishes the status bar. */
  private async refreshConflictStatus(): Promise<void> {
    const records = (await this.coordinator?.list()) ?? [];
    this.lastConflictCount = records.length;
    const fresh = records.filter((record) => !this.announcedConflicts.has(record.conflictId));
    for (const record of fresh) this.announcedConflicts.add(record.conflictId);
    if (fresh.length) new Notice(`Mineral Sync: ${records.length} conflict${records.length === 1 ? "" : "s"} need attention. Run "Mineral Sync: Resolve Conflicts".`);
    this.scheduler?.refreshStatus();
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
