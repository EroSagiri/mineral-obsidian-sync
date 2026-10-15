import { describe, expect, it, vi } from "vitest";
import Plugin from "./main";
import { DEFAULT_SETTINGS, deletionMode, type R2SyncSettings } from "./settings";

describe("deletion mode settings", () => {
  it("defaults missing or unrecognized legacy values to backup", () => {
    expect(DEFAULT_SETTINGS.deletionMode).toBe("backup");
    for (const value of [undefined, null, "", "future", false]) expect(deletionMode(value)).toBe("backup");
    expect(deletionMode("direct")).toBe("direct");
  });
  it("persists mode changes through the plugin settings save and invalidates the captured cycle", async () => {
    const plugin = new Plugin({} as never, { id: "mineral-obsidian-sync" } as never) as unknown as { settings: R2SyncSettings; saveSettings(): Promise<void>; saveData(data: unknown): Promise<void>; applyGatewayConfig(): Promise<void>; scheduler: { configChanged(): void } };
    plugin.settings = { ...DEFAULT_SETTINGS };
    let saved: unknown;
    plugin.saveData = async data => { saved = JSON.parse(JSON.stringify(data)); };
    plugin.applyGatewayConfig = async () => {};
    plugin.scheduler = { configChanged: vi.fn() };
    plugin.settings.deletionMode = "direct"; await plugin.saveSettings();
    expect((saved as R2SyncSettings).deletionMode).toBe("direct");
    plugin.settings = { ...DEFAULT_SETTINGS, ...(saved as Partial<R2SyncSettings>) };
    expect(plugin.settings.deletionMode).toBe("direct");
    plugin.settings.deletionMode = "backup"; await plugin.saveSettings();
    expect((saved as R2SyncSettings).deletionMode).toBe("backup");
    expect(plugin.scheduler.configChanged).toHaveBeenCalledTimes(2);
  });
});
