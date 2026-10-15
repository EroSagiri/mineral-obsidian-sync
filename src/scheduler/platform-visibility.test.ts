import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import Plugin from "../main";
import { SyncScheduler } from "./scheduler";
import type { CycleDependencies } from "./types";

interface Runtime {
  scheduler: SyncScheduler;
  gateway: { setVisible(visible: boolean): void };
  syncMayRun(): boolean;
  onVisibilityChanged(visible: boolean): void;
  debug(message: string): void;
  flushPendingAndroidEditorSaves(trigger: string, force: boolean): Promise<string[]>;
}
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
afterEach(() => {
  vi.useRealTimers();
  Platform.isAndroidApp = false; Platform.isIosApp = false; Platform.isMobile = false;
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

function setup(android: boolean, pause: "scan" | "operation") {
  vi.useFakeTimers(); Platform.isAndroidApp = android;
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  const document = { visibilityState: "visible" };
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  const plugin = new (Plugin as unknown as new (app: unknown) => Runtime)({});
  plugin.debug = () => {};
  plugin.gateway = { setVisible: vi.fn() };
  plugin.flushPendingAndroidEditorSaves = vi.fn(async () => []);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const executed: string[] = [];
  const capture = vi.fn((): CycleDependencies => ({
    scanLocal: () => new Map(),
    scanRemote: async () => { if (pause === "scan") await pending; return new Map(); },
    loadPrevious: async () => new Map(), filterPrevious: entries => entries,
    buildPlan: () => ({ operations: ["a.md", "b.md", "c.md"].map(key => ({ type: "delete-remote" as const, key, reason: "test", expectedRemoteETag: "old" })) }),
    execute: async operation => { executed.push(operation.key); if (pause === "operation" && operation.key === "a.md") await pending; return { status: "applied", key: operation.key, physicalDeleted: true }; },
  }));
  plugin.scheduler = new SyncScheduler({ visible: () => plugin.syncMayRun(), captureCycle: capture });
  const visibility = async (visible: boolean) => {
    document.visibilityState = visible ? "visible" : "hidden";
    plugin.onVisibilityChanged(visible);
    for (let i = 0; i < 24; i++) await Promise.resolve();
  };
  return { plugin, document, capture, executed, release, visibility };
}

describe("platform sync visibility", () => {
  for (const pause of ["scan", "operation"] as const) {
    it(`finishes a desktop batch when hidden during ${pause}, without restarting on window switches`, async () => {
      const env = setup(false, pause);
      env.plugin.scheduler.requestReconcile("manual"); await vi.advanceTimersByTimeAsync(0);
      expect(env.capture).toHaveBeenCalledTimes(1);
      await env.visibility(false); expect(env.plugin.syncMayRun()).toBe(true);
      expect(env.plugin.gateway.setVisible).not.toHaveBeenCalledWith(false);
      env.release(); await vi.advanceTimersByTimeAsync(0);
      expect(env.executed).toEqual(["a.md", "b.md", "c.md"]);
      expect(env.plugin.scheduler.diagnostics().currentState).toBe("idle");
      await env.visibility(true); await vi.advanceTimersByTimeAsync(0);
      expect(env.capture).toHaveBeenCalledTimes(1);
      env.plugin.scheduler.stop();
    });
    it(`still suspends Android at the next boundary when hidden during ${pause}`, async () => {
      const env = setup(true, pause);
      env.plugin.scheduler.requestReconcile("manual"); await vi.advanceTimersByTimeAsync(0);
      expect(env.capture).toHaveBeenCalledTimes(1);
      await env.visibility(false); expect(env.plugin.syncMayRun()).toBe(false);
      expect(env.plugin.flushPendingAndroidEditorSaves).toHaveBeenCalledWith("hidden", true);
      expect(env.plugin.gateway.setVisible).toHaveBeenCalledWith(false);
      env.release(); await vi.advanceTimersByTimeAsync(0);
      expect(env.executed).toEqual(pause === "scan" ? [] : ["a.md"]);
      await env.visibility(true); await vi.advanceTimersByTimeAsync(0);
      expect(env.capture).toHaveBeenCalledTimes(2);
      expect(env.executed.slice(-3)).toEqual(["a.md", "b.md", "c.md"]);
      env.plugin.scheduler.stop();
    });
  }
  it("accepts desktop events while already hidden but keeps mobile startup paused", async () => {
    const env = setup(false, "scan"); await env.visibility(false); env.release();
    env.plugin.scheduler.requestReconcile("remote-change"); await vi.advanceTimersByTimeAsync(0);
    expect(env.executed).toHaveLength(3); env.plugin.scheduler.stop();
    Platform.isIosApp = true;
    expect(env.plugin.syncMayRun()).toBe(false);
    Platform.isIosApp = false; Platform.isMobile = true;
    expect(env.plugin.syncMayRun()).toBe(false);
  });
});
