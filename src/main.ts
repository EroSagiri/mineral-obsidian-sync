import { Notice, Plugin } from "obsidian";
import { scanLocal } from "./local/scan-local";
import { readStableLocalBytes } from "./local/read-local";
import { remoteIdentity, SignedR2ListClient } from "./remote/r2-client";
import { scanRemote } from "./remote/scan-remote";
import { DEFAULT_SETTINGS, R2SyncSettingTab, type R2SyncSettings } from "./settings";
import { IndexedDbStateStore } from "./state/state-store";
import { buildBootstrapResult } from "./bootstrap/bootstrap";
import { DryRunModal } from "./ui/dry-run-modal";
import { createVaultPathFilter, ignorePolicyFingerprint } from "./sync/ignore";
import { registerDevelopmentSelfTests } from "./dev/self-test-command";

export default class R2PersonalSyncPlugin extends Plugin {
  settings: R2SyncSettings = { ...DEFAULT_SETTINGS };
  private readonly stateStore = new IndexedDbStateStore();
  private activeAnalysis?: AbortController;
  private statusBar?: HTMLElement;

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
    // Development-only diagnostics: never registered, and not even bundled, in production.
    if (__DEV__) {
      registerDevelopmentSelfTests({
        app: this.app,
        settings: this.settings,
        addCommand: (command) => this.addCommand(command),
        setStatus: (text) => this.setStatus(text),
      });
    }
    this.statusBar = this.addStatusBarItem();
    this.setStatus("✓ idle");
  }

  onunload(): void { this.activeAnalysis?.abort(); }

  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
  private client(): SignedR2ListClient { return new SignedR2ListClient(this.settings); }
  private debug(message: string): void { if (this.settings.debugLogging) console.debug(`[Mineral Obsidian Sync] ${message}`); }
  private setStatus(text: string): void { this.statusBar?.setText(`Mineral Sync ${text}`); }
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
    } finally { if (this.activeAnalysis === controller) this.activeAnalysis = undefined; }
  }
}
