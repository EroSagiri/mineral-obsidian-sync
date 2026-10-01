import { App, PluginSettingTab, Setting } from "obsidian";
import type R2PersonalSyncPlugin from "./main";
import { R2Configuration } from "./remote/r2-client";
import { DEFAULT_GATEWAY_SETTINGS, type GatewaySettings } from "./gateway/types";
import { DEFAULT_MUTATION_INGRESS_SETTINGS, type MutationIngressSettingsFields } from "./gateway/mutation-ingress";

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
  /** This device's hot-session identity; minted once, never shown to the user. */
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
    const { containerEl } = this; containerEl.empty(); containerEl.createEl("h2", { text: `Mineral Sync v${this.plugin.manifest.version}` });
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
    containerEl.createEl("h3", { text: "热同步（实时协作）" });
    containerEl.createEl("p", { text: "打开一个 Markdown 文件时，本机与服务器建立 CRDT 会话：编辑实时互相可见，R2 由服务器按 2 秒静默 / 10 秒上限的节奏保存。会话期间该路径的冷同步会让路；关闭文件并完成交接后才恢复。未开启时行为与只配置 Gateway 时完全相同。" });
    new Setting(containerEl).setName("启用热同步").setDesc("关闭时不建立任何热会话，冷同步行为不变。需要 Gateway 已启用且配置正确。").addToggle((toggle) => toggle.setValue(this.plugin.settings.hotSyncEnabled).onChange(async (value) => { this.plugin.settings.hotSyncEnabled = value; await this.plugin.saveSettings(); await this.plugin.refreshHotSync(); }));
    new Setting(containerEl).setName("热同步状态").setDesc(this.plugin.hotSyncStatusText());
    containerEl.createEl("h3", { text: "Mutation journal (remote writes this device made)" });
    containerEl.createEl("p", { text: "Optional. After an R2 write lands, this device reports the fact — the exact path and revision — to the Sync Gateway, which relays it to the Vault for verification against R2 and journals it. Nothing else is configured here: the report goes to the Gateway endpoint above, over the channel derived from the R2 identity. It never changes a sync outcome — the write is already durable, so a failure only defers the report." });
    new Setting(containerEl).setName("Report landed writes").setDesc("When off, nothing is reported and the Gateway wake-up is the only notification. When on, this device stops sending its own wake-up: the journal's publisher becomes the only announcer for its writes.").addToggle((toggle) => toggle.setValue(Boolean(this.plugin.settings.mutationIngressEnabled)).onChange(async (value) => { this.plugin.settings.mutationIngressEnabled = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Ingress status").setDesc(this.plugin.mutationIngressStatusText());
    new Setting(containerEl).setName("Integrity reconcile interval").setDesc("While the app is in the foreground, run a full R2 and tombstone verification at this interval (10–30 minutes). Foreground resume always verifies immediately.").addText((input) => {
      input.setValue(String(this.plugin.settings.integrityReconcileIntervalMinutes)).setPlaceholder("20");
      input.inputEl.type = "number";
      input.onChange(async (value) => { this.plugin.settings.integrityReconcileIntervalMinutes = Math.max(10, Math.min(30, Number.parseInt(value, 10) || 20)); await this.plugin.saveSettings(); });
    });
    new Setting(containerEl).setName("Test Connection").setDesc("Runs a read-only R2 ListObjectsV2 request.").addButton((button) => button.setButtonText("Test Connection").onClick(async () => this.plugin.testConnection()));
    new Setting(containerEl).setName("Inspect Sync State").setDesc("Scans metadata, safely verifies ambiguous equal-size pairs, and records only verified-identical initial baselines. It never writes local files or R2 objects.").addButton((button) => button.setButtonText("Inspect").setCta().onClick(async () => this.plugin.inspectSyncState()));
    containerEl.createEl("h3", { text: "Debug logging" });
    containerEl.createEl("p", { text: "Output lands in three places at once: the WebView console (when Debug Logging is on); an in-memory ring of the last 200 lines (always on, used by the resolve-failure report); and the on-disk log at <pluginDir>/debug.log (when Persist Debug Log is on). Use the command palette's `Mineral Sync: Capture Debug Slice` to dump everything since a `mark()` to a separate file." });
    new Setting(containerEl).setName("Debug logging (console)").setDesc("Echo every log line to the WebView developer tools. Off by default; turning it on does not change what's recorded.").addToggle((toggle) => toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => { this.plugin.settings.debugLogging = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Persist debug log (debug.log)").setDesc("Append every log line to <pluginDir>/debug.log, rotated to the last N lines. This is the sink a phone user can pull with `adb`, and the only one that survives an Obsidian restart.").addToggle((toggle) => toggle.setValue(this.plugin.settings.persistDebugLog).onChange(async (value) => { this.plugin.settings.persistDebugLog = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Disk log line cap").setDesc("How many lines the on-disk log keeps before rotation drops the oldest. Larger values mean a longer history on device, at the cost of disk and re-read time.").addText((input) => {
      input.setValue(String(this.plugin.settings.persistDebugLogMaxLines)).setPlaceholder("2000");
      input.inputEl.type = "number";
      input.onChange(async (value) => { this.plugin.settings.persistDebugLogMaxLines = Math.max(200, Math.min(50_000, Number.parseInt(value, 10) || 2000)); await this.plugin.saveSettings(); });
    });
    containerEl.createEl("h4", { text: "Module tags" });
    containerEl.createEl("p", { text: "Each log line is tagged with the module that produced it. Leave on `All tags` to keep everything; switch to `Only these tags` and list one or more to narrow what is recorded. The legacy `main` tag is always on so its own output is never silenced by accident." });
    new Setting(containerEl).setName("Tag filter").addDropdown((dropdown) => {
      const enabled = this.plugin.settings.enabledLogTags;
      dropdown.addOption("*", "All tags");
      dropdown.addOption("list", "Only these tags");
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
    new Setting(containerEl).setName("Show debug log").setDesc("Open the last 60 in-memory log lines in a modal. For the on-disk log, use the file at <pluginDir>/debug.log directly.").addButton((button) => button.setButtonText("Show log").onClick(() => this.plugin.showDebugLog()));
    new Setting(containerEl).setName("Capture debug slice").setDesc("Write everything since the most recent `mark()` (or the whole ring if none) to <pluginDir>/debug-slices/<iso>-<label>.log. Add a label like `investigation-20260524`.").addButton((button) => button.setButtonText("Capture…").setCta().onClick(() => this.plugin.captureDebugSlice()));
  }
}


