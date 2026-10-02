import { App, PluginSettingTab, Setting } from "obsidian";
import type R2PersonalSyncPlugin from "./main";
import { R2Configuration } from "./remote/r2-client";
import { DEFAULT_GATEWAY_SETTINGS, type GatewaySettings } from "./gateway/types";
import { DEFAULT_MUTATION_INGRESS_SETTINGS, type MutationIngressSettingsFields } from "./gateway/mutation-ingress";
import { t } from "./lang";

/**
 * The tags a user can choose to keep. The legacy `"main"` tag is the one the plugin's own
 * `this.debug()` façade emits under; it is always-on regardless of the filter, so a setting
 * change can never silence the plugin itself. The synthetic `"mark"` tag is also always-on
 * so a manual `mark()` always shows up.
 */
export const AVAILABLE_LOG_TAGS = [
  "main",
  "hot.coordinator",
  "hot.session",
  "hot.editor",
  "scheduler",
  "executor",
  "gateway",
  "mutation-ingress",
  "conflict",
  "tombstone",
  "r2",
  "scan-remote",
  "android",
  "mark",
] as const;

export type LogTag = (typeof AVAILABLE_LOG_TAGS)[number] | string;

export interface R2SyncSettings extends R2Configuration, GatewaySettings, MutationIngressSettingsFields {
  debugLogging: boolean;
  /** Append the log to `<pluginDir>/debug.log`; the sink that survives a restart and an `adb pull`. */
  persistDebugLog: boolean;
  /** Max lines kept on disk before rotation kicks in. */
  persistDebugLogMaxLines: number;
  /**
   * `"*"` allows every tag. An array restricts to those (the legacy `"main"` tag stays on regardless).
   * Empty array disables all module-tagged output but keeps the plugin's own `this.debug()` working.
   */
  enabledLogTags: string[] | "*";
  ignoredPaths: string[];
  integrityReconcileIntervalMinutes: number;
  /** Legacy copied identity, retained for settings compatibility; hot sync uses device-local storage. */
  hotClientId: string;
  /**
   * Hot (realtime) collaboration, opt-in.
   *
   * It is off by default even when the Gateway is configured, because it changes the *authority* over a
   * file while that file is open: the server checkpoints it and the cold path is fenced. A device that
   * only wanted the wake-up channel must not acquire that silently.
   */
  hotSyncEnabled: boolean;
}
export const DEFAULT_SETTINGS: R2SyncSettings = {
  ...DEFAULT_GATEWAY_SETTINGS, ...DEFAULT_MUTATION_INGRESS_SETTINGS,
  endpoint: "", bucket: "", accessKeyId: "", secretAccessKey: "", remotePrefix: "",
  debugLogging: false,
  persistDebugLog: false,
  persistDebugLogMaxLines: 2000,
  enabledLogTags: "*",
  ignoredPaths: [],
  integrityReconcileIntervalMinutes: 20,
  hotSyncEnabled: false,
  hotClientId: "",
};

export class R2SyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: R2PersonalSyncPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty(); containerEl.createEl("h2", { text: t("settings.headerVersion", { version: this.plugin.manifest.version }) });
    containerEl.createEl("p", { text: t("settings.credentialsNotice") });
    const text = (nameKey: string, descKey: string, key: keyof R2SyncSettings, secret = false) => {
      new Setting(containerEl).setName(t(nameKey)).setDesc(t(descKey)).addText((input) => {
        input.setValue(String(this.plugin.settings[key])).setPlaceholder(t(nameKey));
        input.inputEl.type = secret ? "password" : "text";
        input.onChange(async (value) => { (this.plugin.settings[key] as string) = value.trim(); await this.plugin.saveSettings(); });
      });
    };
    text("settings.r2Endpoint", "settings.r2EndpointDesc", "endpoint");
    text("settings.bucket", "settings.bucketDesc", "bucket");
    text("settings.accessKeyId", "settings.accessKeyIdDesc", "accessKeyId");
    text("settings.secretAccessKey", "settings.secretAccessKeyDesc", "secretAccessKey", true);
    text("settings.remotePrefix", "settings.remotePrefixDesc", "remotePrefix");
    new Setting(containerEl).setName(t("settings.ignoredPaths")).setDesc(t("settings.ignoredPathsDesc")).addTextArea((input) => {
      input.setValue(this.plugin.settings.ignoredPaths.join("\n")).setPlaceholder(t("settings.ignoredPathsPlaceholder"));
      input.inputEl.rows = 5;
      input.onChange(async (value) => {
        this.plugin.settings.ignoredPaths = [...new Set(value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))];
        await this.plugin.saveSettings();
      });
    });
    containerEl.createEl("h3", { text: t("settings.sectionGateway") });
    containerEl.createEl("p", { text: t("settings.sectionGatewayDesc") });
    new Setting(containerEl).setName(t("settings.gatewayEnabled")).setDesc(t("settings.gatewayEnabledDesc")).addToggle((toggle) => toggle.setValue(this.plugin.settings.gatewayEnabled).onChange(async (value) => { this.plugin.settings.gatewayEnabled = value; await this.plugin.saveSettings(); }));
    text("settings.gatewayEndpoint", "settings.gatewayEndpointDesc", "gatewayEndpoint");
    text("settings.gatewayToken", "settings.gatewayTokenDesc", "gatewayToken", true);
    new Setting(containerEl).setName(t("settings.gatewayStatus")).setDesc(this.plugin.gatewayStatusText());
    containerEl.createEl("h3", { text: t("settings.sectionHot") });
    containerEl.createEl("p", { text: t("settings.sectionHotDesc") });
    new Setting(containerEl).setName(t("settings.hotSyncEnabled")).setDesc(t("settings.hotSyncEnabledDesc")).addToggle((toggle) => toggle.setValue(this.plugin.settings.hotSyncEnabled).onChange(async (value) => { this.plugin.settings.hotSyncEnabled = value; await this.plugin.saveSettings(); await this.plugin.refreshHotSync(); }));
    new Setting(containerEl).setName(t("settings.hotSyncStatus")).setDesc(this.plugin.hotSyncStatusText());
    containerEl.createEl("h3", { text: t("settings.sectionIngress") });
    containerEl.createEl("p", { text: t("settings.sectionIngressDesc") });
    new Setting(containerEl).setName(t("settings.mutationIngressEnabled")).setDesc(t("settings.mutationIngressEnabledDesc")).addToggle((toggle) => toggle.setValue(Boolean(this.plugin.settings.mutationIngressEnabled)).onChange(async (value) => { this.plugin.settings.mutationIngressEnabled = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName(t("settings.mutationIngressStatus")).setDesc(this.plugin.mutationIngressStatusText());
    new Setting(containerEl).setName(t("settings.integrityReconcileInterval")).setDesc(t("settings.integrityReconcileIntervalDesc")).addText((input) => {
      input.setValue(String(this.plugin.settings.integrityReconcileIntervalMinutes)).setPlaceholder(t("settings.integrityReconcileIntervalPlaceholder"));
      input.inputEl.type = "number";
      input.onChange(async (value) => { this.plugin.settings.integrityReconcileIntervalMinutes = Math.max(10, Math.min(30, Number.parseInt(value, 10) || 20)); await this.plugin.saveSettings(); });
    });
    new Setting(containerEl).setName(t("settings.testConnection")).setDesc(t("settings.testConnectionDesc")).addButton((button) => button.setButtonText(t("settings.testConnection")).onClick(async () => this.plugin.testConnection()));
    new Setting(containerEl).setName(t("settings.inspect")).setDesc(t("settings.inspectDesc")).addButton((button) => button.setButtonText(t("settings.inspectButton")).setCta().onClick(async () => this.plugin.inspectSyncState()));
    containerEl.createEl("h3", { text: t("settings.sectionDebug") });
    containerEl.createEl("p", { text: t("settings.sectionDebugDesc") });
    new Setting(containerEl).setName(t("settings.debugConsole")).setDesc(t("settings.debugConsoleDesc")).addToggle((toggle) => toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => { this.plugin.settings.debugLogging = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName(t("settings.persistDebugLog")).setDesc(t("settings.persistDebugLogDesc")).addToggle((toggle) => toggle.setValue(this.plugin.settings.persistDebugLog).onChange(async (value) => { this.plugin.settings.persistDebugLog = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName(t("settings.diskLogLineCap")).setDesc(t("settings.diskLogLineCapDesc")).addText((input) => {
      input.setValue(String(this.plugin.settings.persistDebugLogMaxLines)).setPlaceholder(t("settings.diskLogLineCapPlaceholder"));
      input.inputEl.type = "number";
      input.onChange(async (value) => { this.plugin.settings.persistDebugLogMaxLines = Math.max(200, Math.min(50_000, Number.parseInt(value, 10) || 2000)); await this.plugin.saveSettings(); });
    });
    containerEl.createEl("h4", { text: t("settings.sectionTags") });
    containerEl.createEl("p", { text: t("settings.sectionTagsDesc") });
    new Setting(containerEl).setName(t("settings.tagFilter")).addDropdown((dropdown) => {
      const enabled = this.plugin.settings.enabledLogTags;
      dropdown.addOption("*", t("settings.tagFilterAll"));
      dropdown.addOption("list", t("settings.tagFilterList"));
      dropdown.setValue(enabled === "*" ? "*" : "list");
      dropdown.onChange(async (value) => {
        if (value === "*") this.plugin.settings.enabledLogTags = "*";
        else if (this.plugin.settings.enabledLogTags === "*") this.plugin.settings.enabledLogTags = ["main"];
        await this.plugin.saveSettings();
        this.display();
      });
    });
    if (this.plugin.settings.enabledLogTags !== "*") {
      const tagsContainer = containerEl.createDiv({ cls: "mineral-sync-tag-list" });
      for (const tag of AVAILABLE_LOG_TAGS) {
        if (tag === "main" || tag === "mark") continue;
        const isOn = (this.plugin.settings.enabledLogTags as string[]).includes(tag);
        new Setting(tagsContainer).setName(tag).addToggle((toggle) => toggle.setValue(isOn).onChange(async (value) => {
          const list = new Set(this.plugin.settings.enabledLogTags as string[]);
          if (value) list.add(tag);
          else list.delete(tag);
          this.plugin.settings.enabledLogTags = Array.from(list);
          await this.plugin.saveSettings();
        }));
      }
    }
    new Setting(containerEl).setName(t("settings.showDebugLog")).setDesc(t("settings.showDebugLogDesc")).addButton((button) => button.setButtonText(t("settings.showDebugLogButton")).onClick(() => this.plugin.showDebugLog()));
    new Setting(containerEl).setName(t("settings.captureDebugSlice")).setDesc(t("settings.captureDebugSliceDesc")).addButton((button) => button.setButtonText(t("settings.captureDebugSliceButton")).setCta().onClick(() => this.plugin.captureDebugSlice()));
  }
}

