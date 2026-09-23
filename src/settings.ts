import { App, PluginSettingTab, Setting } from "obsidian";
import type R2PersonalSyncPlugin from "./main";
import { R2Configuration } from "./remote/r2-client";
import { DEFAULT_GATEWAY_SETTINGS, type GatewaySettings } from "./gateway/types";
import { DEFAULT_MUTATION_INGRESS_SETTINGS, type MutationIngressSettingsFields } from "./gateway/mutation-ingress";

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
    const { containerEl } = this; containerEl.empty(); containerEl.createEl("h2", { text: "Mineral Sync — Phase 1.5" });
    containerEl.createEl("p", { text: "Credentials use Obsidian's normal local plugin settings storage; this plugin does not encrypt them." });
    const text = (name: string, description: string, key: keyof R2SyncSettings, secret = false) => {
      new Setting(containerEl).setName(name).setDesc(description).addText((input) => {
        input.setValue(String(this.plugin.settings[key])).setPlaceholder(name);
        input.inputEl.type = secret ? "password" : "text";
        input.onChange(async (value) => { (this.plugin.settings[key] as string) = value.trim(); await this.plugin.saveSettings(); });
      });
    };
    text("R2 endpoint", "Example: https://<account-id>.r2.cloudflarestorage.com", "endpoint");
    text("Bucket", "The R2 bucket name.", "bucket");
    text("Access key ID", "R2 S3-compatible API access key ID.", "accessKeyId");
    text("Secret access key", "Stored locally by Obsidian; never logged by this plugin.", "secretAccessKey", true);
    text("Remote prefix", "Optional object-key prefix, with no leading slash.", "remotePrefix");
    new Setting(containerEl).setName("Ignored paths").setDesc("One vault-relative path per line. The path itself and its complete contents are excluded from local and R2 planning.").addTextArea((input) => {
      input.setValue(this.plugin.settings.ignoredPaths.join("\n")).setPlaceholder(".history\n.trash\ndaily/private.md");
      input.inputEl.rows = 5;
      input.onChange(async (value) => {
        this.plugin.settings.ignoredPaths = [...new Set(value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))];
        await this.plugin.saveSettings();
      });
    });
    containerEl.createEl("h3", { text: "Sync Gateway (low-latency wake-up)" });
    containerEl.createEl("p", { text: "Optional control plane. It only tells other devices that the remote may have changed; it never carries file content, and R2 sync keeps working when it is off or unreachable. The channel is derived from the R2 endpoint, bucket, and prefix, so every device sharing one namespace agrees automatically — there is nothing to type here." });
    new Setting(containerEl).setName("Gateway enabled").setDesc("When off, syncing is driven only by local events, startup, focus, and the manual command.").addToggle((toggle) => toggle.setValue(this.plugin.settings.gatewayEnabled).onChange(async (value) => { this.plugin.settings.gatewayEnabled = value; await this.plugin.saveSettings(); }));
    text("Gateway endpoint", "Example: https://mineral-sync-gateway.<subdomain>.workers.dev", "gatewayEndpoint");
    text("Gateway token", "The Gateway bearer secret. Stored locally; never logged and never placed in a URL.", "gatewayToken", true);
    new Setting(containerEl).setName("Gateway status").setDesc(this.plugin.gatewayStatusText());
    containerEl.createEl("h3", { text: "Mutation journal (remote writes this device made)" });
    containerEl.createEl("p", { text: "Optional. After an R2 write lands, this device can report the fact — the exact path and revision — to the Vault's mutation ingress, which verifies it against R2 and publishes it. It never changes a sync outcome: the write is already durable, so a failure only defers the report. Deletions are not reported yet, because this plugin deletes logically and the ingress expects the object to be gone." });
    new Setting(containerEl).setName("Report landed writes").setDesc("When off, nothing is reported and the Gateway wake-up is the only notification.").addToggle((toggle) => toggle.setValue(this.plugin.settings.mutationIngressEnabled).onChange(async (value) => { this.plugin.settings.mutationIngressEnabled = value; await this.plugin.saveSettings(); }));
    text("Ingress endpoint", "The Vault worker's base URL. The report is a POST to /internal/mutations.", "mutationIngressEndpoint");
    text("Ingress token", "The mutation ingress bearer secret. Stored locally; never logged and never placed in a URL.", "mutationIngressToken", true);
    new Setting(containerEl).setName("Ingress status").setDesc(this.plugin.mutationIngressStatusText());
    new Setting(containerEl).setName("Integrity reconcile interval").setDesc("While the app is in the foreground, run a full R2 and tombstone verification at this interval (10–30 minutes). Foreground resume always verifies immediately.").addText((input) => {
      input.setValue(String(this.plugin.settings.integrityReconcileIntervalMinutes)).setPlaceholder("20");
      input.inputEl.type = "number";
      input.onChange(async (value) => { this.plugin.settings.integrityReconcileIntervalMinutes = Math.max(10, Math.min(30, Number.parseInt(value, 10) || 20)); await this.plugin.saveSettings(); });
    });
    new Setting(containerEl).setName("Test Connection").setDesc("Runs a read-only R2 ListObjectsV2 request.").addButton((button) => button.setButtonText("Test Connection").onClick(async () => this.plugin.testConnection()));
    new Setting(containerEl).setName("Inspect Sync State").setDesc("Scans metadata, safely verifies ambiguous equal-size pairs, and records only verified-identical initial baselines. It never writes local files or R2 objects.").addButton((button) => button.setButtonText("Inspect").setCta().onClick(async () => this.plugin.inspectSyncState()));
  }
}
