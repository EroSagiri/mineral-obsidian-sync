import { Notice } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, flush, installModalContainer } from "../../test/dom";
import { manualHistoryEntry, mergeHistoryEntry, restoreHistoryEntry, snapshotOf } from "../history/entry";
import type { SyncHistoryEntry } from "../history/types";

/**
 * The viewer's three pages.
 *
 * The promises under test: the list groups by day and says what happened, a snapshot's raw facts
 * (hashes, etags, metadata) exist only inside the collapsed technical details, long text is truncated
 * until asked for, and a restore happens only after the user presses `Restore` on the confirmation
 * page — with the UI never claiming that the sync itself finished.
 */

const CHANNEL = "A".repeat(43);
const TEXT = {
  base: "windows\nsf\n",
  local: "windows\nsf\nfrom windows\n",
  remote: "windows\nsf\noppo\n",
  result: "windows\nsf\nfrom windows\noppo\n",
};

interface RestoreInput { path: string; content: string; sourceHistoryId: string }

/** The stub records what was shown; `Notice` has no such static in the real types. */
const shownNotices = (): string[] => (Notice as unknown as { shown: string[] }).shown;

/** A local time on a day counted back from today, so day grouping is exercised, not faked. */
const at = (hours: number, minutes: number, daysAgo = 0): number => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
};

const autoMerge = async (path = "notes/a.md", timestamp = at(9, 5)): Promise<SyncHistoryEntry> => mergeHistoryEntry({
  channel: CHANNEL,
  path,
  type: "clean-auto-merge",
  timestamp,
  base: await snapshotOf(TEXT.base),
  localBefore: await snapshotOf(TEXT.local, { modified: timestamp }),
  remoteBefore: await snapshotOf(TEXT.remote, { etag: "ETAG-REMOTE", modified: timestamp - 3000 }),
  result: TEXT.result,
  resultETag: "ETAG-RESULT",
  metadata: { localDeltaBytes: 84, branchSeparationMs: 6200, hunkCount: 1, mergeReason: "one region", order: "stable-content" },
});

const manual = async (path = "notes/b.md", timestamp = at(11, 30)): Promise<SyncHistoryEntry> => manualHistoryEntry({
  channel: CHANNEL,
  path,
  conflictId: "conflict-identity-2",
  timestamp,
  resolutionType: "keep-local",
  localBefore: await snapshotOf(TEXT.local),
  remoteBefore: await snapshotOf(TEXT.remote),
  result: TEXT.local,
});

const handoff = async (path = "notes/c.md", timestamp = at(20, 10, 1)): Promise<SyncHistoryEntry> => mergeHistoryEntry({
  channel: CHANNEL,
  path,
  type: "handoff-auto-merge",
  timestamp,
  base: await snapshotOf(TEXT.base),
  localBefore: await snapshotOf(TEXT.local),
  remoteBefore: await snapshotOf(TEXT.remote),
  result: TEXT.result,
  metadata: { branchSeparationMs: 4100, hunkCount: 1 },
});

const restore = async (path = "notes/d.md", timestamp = at(12, 0, 3)): Promise<SyncHistoryEntry> => restoreHistoryEntry({
  channel: CHANNEL,
  path,
  timestamp,
  sourceHistoryId: "h1-abcdefgh",
  previousCurrent: await snapshotOf(TEXT.result, { modified: timestamp - 1000 }),
  result: TEXT.base,
  resultETag: "ETAG-RESTORE",
});

async function open(entries: SyncHistoryEntry[], restoreDependency: (input: RestoreInput) => Promise<void> = async () => {}): Promise<{ container: FakeElement; modal: { close(): void } }> {
  const container = new FakeElement("div");
  const { SyncHistoryModal } = await import("./sync-history-modal");
  const modal = new SyncHistoryModal({} as never, { list: async () => entries, restore: restoreDependency });
  installModalContainer(modal, container);
  await modal.onOpen();
  return { container, modal: modal as unknown as { close(): void } };
}

/** The row of one path, so a test presses `View` on the entry it means. */
const rowFor = (container: FakeElement, path: string): FakeElement =>
  container.findAll((element) => element.classes.has("mineral-sync-history__row")).find((row) => row.find((element) => element.text === path))!;

const openDetail = async (entry: SyncHistoryEntry, restoreDependency?: (input: RestoreInput) => Promise<void>): Promise<FakeElement> => {
  const { container } = await open([entry], restoreDependency);
  container.button("View")!.click();
  return container;
};

beforeEach(() => { shownNotices().length = 0; });

describe("viewer safety", () => {
  it("is constructed from exactly two capabilities, none of which can write content", async () => {
    const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("./sync-history-modal.ts", import.meta.url), "utf8"));
    const start = source.indexOf("export interface SyncHistoryDependencies");
    const end = source.indexOf("const PREVIEW_LIMIT");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const interfaceBlock = source.slice(start, end);
    for (const forbidden of ["Vault ", "R2Client", "requestUrl", "putObject", "modifyBinary", "createBinary", "adapter", "fetch(", "StateStore"]) {
      expect(interfaceBlock, `dependency interface must not expose ${forbidden}`).not.toContain(forbidden);
    }
    expect(interfaceBlock).toContain("list()");
    expect(interfaceBlock).toContain("restore(");
    expect(interfaceBlock).toContain("debug?");
  });

  it("styles itself from theme variables only", async () => {
    const { SYNC_HISTORY_CSS } = await import("./history-styles");
    const declarations: string[] = [];
    for (const rule of SYNC_HISTORY_CSS.split("}")) {
      const body = rule.slice(rule.indexOf("{") + 1);
      for (const declaration of body.split(";")) if (declaration.includes(":")) declarations.push(declaration);
    }
    for (const declaration of declarations) {
      const property = declaration.split(":")[0];
      if (!/(color|background|border|shadow)/i.test(property)) continue;
      expect(declaration, declaration).toContain("var(--");
    }
    expect(SYNC_HISTORY_CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(SYNC_HISTORY_CSS).not.toMatch(/\brgba?\(/i);
    expect(SYNC_HISTORY_CSS).toContain("mineral-sync-history__row");
    expect(SYNC_HISTORY_CSS).toContain("var(--background-secondary)");
    expect(SYNC_HISTORY_CSS).toContain("var(--text-muted)");
  });
});

describe("list page", () => {
  it("groups entries by day and says what each one did", async () => {
    const { container } = await open([await manual(), await autoMerge(), await handoff(), await restore()]);

    expect(container.find((element) => element.text === "Mineral Sync History")).toBeDefined();
    const headings = container.findAll((element) => element.classes.has("mineral-sync-history__day")).map((element) => element.text);
    expect(headings).toEqual(["Today", "Yesterday", new Date(at(12, 0, 3)).toLocaleDateString()]);

    expect(container.findAll((element) => element.classes.has("mineral-sync-history__row"))).toHaveLength(4);
    expect(container.findAll((element) => element.tag === "button" && element.text === "View")).toHaveLength(4);

    const row = rowFor(container, "notes/a.md");
    expect(row.find((element) => element.classes.has("mineral-sync-history__time"))!.text).toBe("09:05");
    expect(row.find((element) => element.classes.has("mineral-sync-history__description"))!.text).toBe("Auto-merged non-overlapping changes");
    expect(row.find((element) => element.classes.has("mineral-sync-history__evidence"))!.text).toBe("84 B added · 6.2s apart · 1 region");
    expect(rowFor(container, "notes/b.md").find((element) => element.classes.has("mineral-sync-history__description"))!.text).toBe("Conflict resolved manually");
    // A handoff with no byte deltas still reports the time and the region.
    expect(rowFor(container, "notes/c.md").find((element) => element.classes.has("mineral-sync-history__evidence"))!.text).toBe("4.1s apart · 1 region");
    expect(rowFor(container, "notes/d.md").find((element) => element.classes.has("mineral-sync-history__evidence"))).toBeUndefined();
  });

  it("shows an empty state rather than an empty list", async () => {
    const { container } = await open([]);
    expect(container.find((element) => element.text === "No history yet.")).toBeDefined();
    expect(container.button("View")).toBeUndefined();
    expect(container.findAll((element) => element.tag === "details")).toHaveLength(0);
  });

  it("truncates a long path in the middle", async () => {
    const long = "Projects/2026/quarterly reports/attachments/deeply/nested/meeting-notes.md";
    const { container } = await open([await autoMerge(long)]);
    // The row cannot be found by its full path: the path on screen is the truncated one.
    const row = container.findAll((element) => element.classes.has("mineral-sync-history__row"))[0]!;
    const shown = row.find((element) => element.classes.has("mineral-sync-history__path"))!.text;
    expect(shown.length).toBe(48);
    expect(shown).toContain("…");
    expect(shown.startsWith("Projects/2026/qua")).toBe(true);
    expect(shown.endsWith("meeting-notes.md")).toBe(true);
  });
});

describe("detail page", () => {
  it("shows the result and the versions it replaced, and goes back", async () => {
    const container = await openDetail(await autoMerge());

    expect(container.find((element) => element.text === "notes/a.md")).toBeDefined();
    expect(container.find((element) => element.text === "Auto-merged non-overlapping changes")).toBeDefined();
    expect(container.find((element) => element.text === new Date(at(9, 5)).toLocaleString())).toBeDefined();
    expect(container.find((element) => element.text === "Result")).toBeDefined();
    expect(container.find((element) => element.classes.has("mineral-sync-history__preview"))!.text).toBe(TEXT.result);
    expect(container.find((element) => element.text === "Before merge")).toBeDefined();
    expect(container.find((element) => element.text === "This device")).toBeDefined();
    expect(container.find((element) => element.text === "Other version")).toBeDefined();
    expect(container.findAll((element) => element.tag === "button" && element.text === "Restore this version")).toHaveLength(2);
    expect(container.button("View")).toBeUndefined();

    container.button("Back")!.click();
    expect(container.findAll((element) => element.classes.has("mineral-sync-history__row"))).toHaveLength(1);
    expect(container.find((element) => element.text === "Before merge")).toBeUndefined();
  });

  it("offers only the sides that exist", async () => {
    const onlyLocal = await mergeHistoryEntry({
      channel: CHANNEL, path: "notes/one-sided.md", type: "clean-auto-merge", timestamp: at(8, 0), localBefore: await snapshotOf(TEXT.local), result: TEXT.result,
    });
    const container = await openDetail(onlyLocal);
    expect(container.find((element) => element.text === "This device")).toBeDefined();
    expect(container.find((element) => element.text === "Other version")).toBeUndefined();
    expect(container.findAll((element) => element.tag === "button" && element.text === "Restore this version")).toHaveLength(1);
  });

  it("keeps technical details collapsed, and keeps the raw facts nowhere else", async () => {
    const entry = await autoMerge();
    const container = await openDetail(entry);

    const details = container.findAll((element) => element.tag === "details");
    expect(details).toHaveLength(1);
    expect(details[0]!.open).toBe(false);
    expect(details[0]!.find((element) => element.text === "Technical details")).toBeDefined();

    const raw = details[0]!.allText;
    expect(raw).toContain(entry.id);
    expect(raw).toContain("clean-auto-merge");
    expect(raw).toContain(entry.base!.sha256);
    expect(raw).toContain(entry.localBefore!.sha256);
    expect(raw).toContain(entry.remoteBefore!.sha256);
    expect(raw).toContain("ETAG-REMOTE");
    expect(raw).toContain(new Date(at(9, 5)).toISOString());
    expect(raw).toContain("mergeReason");
    expect(raw).toContain("one region");
    expect(raw).toContain("order");
    expect(raw).toContain(TEXT.base);

    // Nothing a user sees without opening the details may carry a hash, an etag or an id.
    const visible = container.visibleText;
    for (const secret of [entry.id, entry.base!.sha256, entry.localBefore!.sha256, entry.remoteBefore!.sha256, entry.result.sha256, "ETAG-REMOTE", "ETAG-RESULT"]) {
      expect(visible, secret).not.toContain(secret);
    }
  });

  it("truncates a long result until the full text is asked for", async () => {
    const long = "x".repeat(3000);
    const entry = await mergeHistoryEntry({ channel: CHANNEL, path: "notes/long.md", type: "clean-auto-merge", timestamp: at(9, 0), localBefore: await snapshotOf("short\n"), result: long });
    const container = await openDetail(entry);

    expect(container.find((element) => element.classes.has("mineral-sync-history__preview"))!.text).toHaveLength(2000);
    container.button("Show full text")!.click();

    expect(container.find((element) => element.classes.has("mineral-sync-history__preview"))!.text).toHaveLength(3000);
    expect(container.button("Show full text")).toBeUndefined();
    // Still the detail page, expanded in place.
    expect(container.find((element) => element.text === "notes/long.md")).toBeDefined();
    expect(container.button("Back")).toBeDefined();
  });

  it("does not offer the full-text button for a short result", async () => {
    const container = await openDetail(await autoMerge());
    expect(container.button("Show full text")).toBeUndefined();
  });
});

describe("restore confirmation", () => {
  const confirmBody = (path: string): string[] => [
    "Restore this version?",
    `This will make this historical snapshot the current version of ${path}.`,
    "A new sync version will be created. Current history will not be deleted.",
  ];

  it("states exactly what will happen, and writes nothing before Restore", async () => {
    const restoreSpy = vi.fn(async (_input: RestoreInput) => {});
    const container = await openDetail(await autoMerge(), restoreSpy);

    container.button("Restore this version")!.click();
    for (const line of confirmBody("notes/a.md")) expect(container.find((element) => element.text === line), line).toBeDefined();
    expect(container.findAll((element) => element.tag === "button" && element.classes.has("mod-cta")).map((button) => button.text)).toEqual(["Restore"]);
    expect(container.button("Cancel")).toBeDefined();
    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it("restores this device's own version, through the injected dependency, only after Restore", async () => {
    const calls: RestoreInput[] = [];
    const entry = await autoMerge();
    const container = await openDetail(entry, async (input) => { calls.push(input); });

    container.button("Restore this version")!.click();
    expect(calls).toHaveLength(0);
    container.button("Restore")!.click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ path: "notes/a.md", content: TEXT.local, sourceHistoryId: entry.id });

    // Success returns to the list and says so, without any claim that a sync already finished.
    await vi.waitFor(() => expect(container.find((element) => element.text === "Version restored. It will sync like any other change.")).toBeDefined());
    expect(container.findAll((element) => element.classes.has("mineral-sync-history__row"))).toHaveLength(1);
    expect(shownNotices()).toEqual([]);
    expect(container.visibleText).not.toContain("Synced");
    expect(container.visibleText).not.toContain("Sync complete");
  });

  it("restores the other side from its own button", async () => {
    const calls: RestoreInput[] = [];
    const container = await openDetail(await autoMerge(), async (input) => { calls.push(input); });
    // The second control belongs to "Other version", which is the remote snapshot.
    container.findAll((element) => element.tag === "button" && element.text === "Restore this version")[1]!.click();
    container.button("Restore")!.click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.content).toBe(TEXT.remote);
  });

  it("cancels without touching anything", async () => {
    const restoreSpy = vi.fn(async (_input: RestoreInput) => {});
    const container = await openDetail(await autoMerge(), restoreSpy);
    container.button("Restore this version")!.click();
    container.button("Cancel")!.click();

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(container.find((element) => element.text === "Before merge")).toBeDefined();
    expect(container.find((element) => element.text === "Restore this version?")).toBeUndefined();
  });

  it("takes only the first click while a restore is in flight", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const restoreSpy = vi.fn((_input: RestoreInput) => gate);
    const container = await openDetail(await autoMerge(), restoreSpy);

    container.button("Restore this version")!.click();
    container.button("Restore")!.click();
    container.button("Restore")!.click();
    expect(restoreSpy).toHaveBeenCalledTimes(1);

    release();
    await flush();
    await vi.waitFor(() => expect(container.find((element) => element.text === "Version restored. It will sync like any other change.")).toBeDefined());
  });

  it("reports a failed restore and leaves the history alone", async () => {
    const container = await openDetail(await autoMerge(), async () => { throw new Error("r2 refused the write"); });
    container.button("Restore this version")!.click();
    container.button("Restore")!.click();

    await vi.waitFor(() => expect(shownNotices()).toContain("Mineral Sync: the version could not be restored."));
    expect(container.find((element) => element.text === "Version restored. It will sync like any other change.")).toBeUndefined();
    // The user stays on the confirmation, so a failure is never mistaken for a completed restore.
    expect(container.button("Restore")).toBeDefined();
    expect(container.find((element) => element.text === "Restore this version?")).toBeDefined();
  });

  it("offers no confirmation for a restore that was never requested", async () => {
    const restoreSpy = vi.fn(async (_input: RestoreInput) => {});
    const { container } = await open([await autoMerge(), await handoff()], restoreSpy);
    expect(container.find((element) => element.text === "Restore this version?")).toBeUndefined();
    expect(restoreSpy).not.toHaveBeenCalled();
  });
});
