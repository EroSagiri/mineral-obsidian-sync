import { App, PluginSettingTab, Setting } from "obsidian";
import type R2PersonalSyncPlugin from "./main";
import { R2Configuration } from "./remote/r2-client";
import { DEFAULT_GATEWAY_SETTINGS, type GatewaySettings } from "./gateway/types";
import { DEFAULT_MUTATION_INGRESS_SETTINGS, type MutationIngressSettingsFields } from "./gateway/mutation-ingress";
import { t } from "./lang";

export interface R2SyncSettings extends R2Configuration, GatewaySettings, MutationIngressSettingsFields {
  debugLogging: boolean;
  ignoredPaths: string[];
  integrityReconcileIntervalMinutes: number;
}
export const DEFAULT_SETTINGS: R2SyncSettings = {
  ...DEFAULT_GATEWAY_SETTINGS, ...DEFAULT_MUTATION_INGRESS_SETTINGS,
  endpoint: "", bucket: "", accessKeyId: "", secretAccessKey: "", remotePrefix: "",
  debugLogging: false, ignoredPaths: [], integrityReconcileIntervalMinutes: 20,
};

export class R2SyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: R2PersonalSyncPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty(); containerEl.createEl("h2", { text: t("settings.headerVersion", { version: this.plugin.manifest.version }) });
    containerEl.createEl("p", { text: t("settings.credentialsNotice") });
    const text = (nameKey: string, descriptionKey: string, key: keyof R2SyncSettings, secret = false) => {
      new Setting(containerEl).setName(t(nameKey)).setDesc(t(descriptionKey)).addText((input) => {
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
  }
}
