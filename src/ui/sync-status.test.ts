import { describe, expect, it } from "vitest";
import { FakeElement } from "../../test/dom";
import type { ResultCounts } from "../scheduler/types";
import { presentSyncStatus, renderSyncStatus, SYNC_STATUS_ICON, type SyncStatusInput } from "./sync-status";

/**
 * The status bar is the whole of the plugin's ambient feedback, so its mapping is pinned here: one
 * icon, five tones, and an explicit priority order. Nothing in this file touches the sync engine.
 */

const counts = (overrides: Partial<ResultCounts> = {}): ResultCounts => ({ applied: 0, stale: 0, failed: 0, unresolved: 0, blocked: 0, partial: 0, conflict: 0, noop: 0, ...overrides });
const input = (overrides: Partial<SyncStatusInput> = {}): SyncStatusInput => ({ state: "idle", counts: counts(), conflictCount: 0, ...overrides });

const render = (value: SyncStatusInput): FakeElement => {
  const host = new FakeElement("div");
  renderSyncStatus(host as unknown as HTMLElement, presentSyncStatus(value));
  return host;
};
const status = (host: FakeElement): FakeElement => host.find((element) => element.classes.has("mineral-sync-status"))!;

describe("sync status mapping", () => {
  it("shows idle as a still, muted icon and no readable status text", () => {
    const presentation = presentSyncStatus(input());
    expect(presentation.tone).toBe("idle");
    expect(presentation.spinning).toBe(false);
    expect(presentation.badge).toBeUndefined();
    expect(presentation.tooltip).toBe("Mineral Sync\nUp to date");
    expect(presentation.icon).toBe(SYNC_STATUS_ICON);

    const host = render(input());
    expect(status(host).classes.has("mineral-sync-status--idle")).toBe(true);
    // The old bar printed "Mineral Sync ✓ idle" into the status bar; only the icon may be visible now.
    expect(host.allText).toBe("");
  });

  it("shows waiting as a fainter still icon, never as an error", () => {
    for (const state of ["debouncing", "rerun-pending"] as const) {
      const presentation = presentSyncStatus(input({ state }));
      expect(presentation.tone).toBe("waiting");
      expect(presentation.spinning).toBe(false);
      expect(presentation.tooltip).toContain("Waiting for changes to settle");
      expect(status(render(input({ state }))).classes.has("mineral-sync-status--waiting")).toBe(true);
    }
  });

  it("shows syncing as the same icon, spinning", () => {
    const presentation = presentSyncStatus(input({ state: "running" }));
    expect(presentation.tone).toBe("syncing");
    expect(presentation.spinning).toBe(true);
    expect(presentation.tooltip).toBe("Mineral Sync\nSyncing…");
    expect(status(render(input({ state: "running" }))).classes.has("is-spinning")).toBe(true);
  });

  it("shows conflicts in yellow with the count as a badge, and never spins", () => {
    const presentation = presentSyncStatus(input({ state: "running", conflictCount: 3 }));
    expect(presentation.tone).toBe("conflict");
    expect(presentation.badge).toBe("3");
    expect(presentation.spinning).toBe(false);
    expect(presentation.tooltip).toContain("3 conflicts need attention");
    expect(presentation.tooltip).toContain("Click to resolve");

    const host = render(input({ state: "running", conflictCount: 3 }));
    expect(status(host).classes.has("mineral-sync-status--conflict")).toBe(true);
    expect(host.find((element) => element.classes.has("mineral-sync-status__badge"))!.text).toBe("3");
    // Conflict outranks a running cycle, and the count is the only visible text.
    expect(host.allText).toBe("3");
  });

  it("says conflict, not conflict, for exactly one", () => {
    const presentation = presentSyncStatus(input({ conflictCount: 1 }));
    expect(presentation.tooltip).toContain("1 conflict need");
    expect(presentation.tooltip).not.toContain("conflicts");
  });

  it("shows offline as red and still", () => {
    const presentation = presentSyncStatus(input({ lastFailureClass: "retryable" }));
    expect(presentation.tone).toBe("offline");
    expect(presentation.spinning).toBe(false);
    expect(presentation.tooltip).toContain("Offline");
    expect(status(render(input({ lastFailureClass: "retryable" }))).classes.has("mineral-sync-status--offline")).toBe(true);
  });

  it("treats an ambiguous write as offline too", () => {
    expect(presentSyncStatus(input({ counts: counts({ unresolved: 1 }) })).tone).toBe("offline");
  });

  it("shows a definitive failure as an error with a marker badge", () => {
    const rejected = presentSyncStatus(input({ state: "blocked-by-auth" }));
    expect(rejected.tone).toBe("error");
    expect(rejected.badge).toBe("!");
    expect(rejected.tooltip).toContain("credentials");

    const refused = presentSyncStatus(input({ lastFailureClass: "stable" }));
    expect(refused.tone).toBe("error");
    expect(refused.badge).toBe("!");
    expect(status(render(input({ lastFailureClass: "stable" }))).classes.has("mineral-sync-status--error")).toBe(true);
  });

  it("orders conflict above offline, and offline above syncing", () => {
    expect(presentSyncStatus(input({ state: "running", lastFailureClass: "retryable", conflictCount: 2 })).tone).toBe("conflict");
    expect(presentSyncStatus(input({ state: "running", lastFailureClass: "retryable" })).tone).toBe("offline");
    expect(presentSyncStatus(input({ state: "running" })).tone).toBe("syncing");
    expect(presentSyncStatus(input({ state: "debouncing" })).tone).toBe("waiting");
  });

  it("sends a click to the resolver only when a conflict needs one", () => {
    expect(presentSyncStatus(input({ conflictCount: 1 })).action).toBe("resolve-conflicts");
    for (const other of [input(), input({ state: "running" }), input({ lastFailureClass: "retryable" }), input({ state: "blocked-by-auth" })]) {
      expect(presentSyncStatus(other).action).toBe("sync-now");
    }
  });

  it("carries the tooltip in the attribute Obsidian reads, and colours by variables only", () => {
    const host = render(input({ conflictCount: 2 }));
    const root = status(host);
    expect(root.getAttribute("aria-label")).toBe("Mineral Sync\n2 conflicts need attention\nClick to resolve");
    expect(root.getAttribute("data-tooltip-position")).toBe("top");
  });

  it("never styles a tone with a hard-coded colour", async () => {
    const { SYNC_STATUS_CSS } = await import("./sync-status");
    // Every colour must come from a theme variable so light and dark both work without a second rule.
    const declarations = SYNC_STATUS_CSS.split("\n").filter((line) => line.includes(":") && !line.trim().startsWith("@") && !line.includes("{"));
    for (const declaration of declarations) {
      expect(declaration, declaration).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(declaration, declaration).not.toMatch(/\brgba?\(/i);
    }
    expect(SYNC_STATUS_CSS).toContain("var(--color-yellow");
    expect(SYNC_STATUS_CSS).toContain("var(--color-red");
    expect(SYNC_STATUS_CSS).toContain("var(--interactive-accent)");
    expect(SYNC_STATUS_CSS).toContain("var(--text-muted)");
  });
});
