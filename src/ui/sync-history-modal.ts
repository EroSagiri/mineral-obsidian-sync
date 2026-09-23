import { Modal, Notice, type App } from "obsidian";
import { describeHistoryEntry, describeHistoryEvidence } from "../history/entry";
import type { SyncHistoryEntry, SyncHistorySnapshot } from "../history/types";

/**
 * The sync history viewer.
 *
 * Three pages in one modal, in the order a user acts:
 *
 * - **list** answers "what happened recently", grouped by day so a session reads as one block;
 * - **detail** answers "what did this change, and what did each side hold first", and is the only
 *   place a version can be chosen for recovery;
 * - **confirm** exists because a restore overwrites the current file. It states exactly what will
 *   happen before anything runs.
 *
 * The rule this file must never break: **the UI does not write files.** It renders snapshots and calls
 * one injected `restore`, which is defined to go through normal sync, so a restore is visible to every
 * other device exactly like a hand-typed edit.
 */
export interface SyncHistoryDependencies {
  list(): Promise<SyncHistoryEntry[]>;
  /** Makes a historical snapshot the current content of the path, through normal sync. */
  restore(input: { path: string; content: string; sourceHistoryId: string }): Promise<void>;
  debug?(message: string): void;
}

const PREVIEW_LIMIT = 2000;
/** Long enough to stay identifiable, short enough not to push the time and button out of the row. */
const PATH_LIMIT = 48;

type Page = "list" | "detail" | "confirm";

const pad = (value: number): string => value.toString().padStart(2, "0");

const clockTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** Local calendar day, used as the grouping key so a day boundary is the user's, not UTC's. */
const dayKey = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

function dayLabel(timestamp: number, now: number): string {
  if (dayKey(timestamp) === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(timestamp) === dayKey(yesterday.getTime())) return "Yesterday";
  return new Date(timestamp).toLocaleDateString();
}

/** Truncates in the middle: the folder and the file name are what identify a path, not its middle. */
export function truncatePath(path: string, limit = PATH_LIMIT): string {
  if (path.length <= limit) return path;
  const head = Math.ceil((limit - 1) / 2);
  return `${path.slice(0, head)}…${path.slice(path.length - (limit - 1 - head))}`;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} kB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function snapshotFacts(snapshot: SyncHistorySnapshot): string {
  const lines = [`sha256: ${snapshot.sha256}`, `size: ${sizeLabel(snapshot.size)}`];
  if (snapshot.etag !== undefined) lines.push(`etag: ${snapshot.etag}`);
  if (snapshot.modified !== undefined) lines.push(`modified: ${new Date(snapshot.modified).toISOString()}`);
  return lines.join("\n");
}

export class SyncHistoryModal extends Modal {
  private entries: SyncHistoryEntry[] = [];
  private page: Page = "list";
  private selected?: SyncHistoryEntry;
  private pending?: { entry: SyncHistoryEntry; snapshot: SyncHistorySnapshot };
  /** The result preview is collapsed when it is long; expanding is a page state, so it survives a render. */
  private expanded = false;
  private notice?: string;
  /** Guards the confirmation against a double click while the restore is still in flight. */
  private restoring = false;

  constructor(app: App, private readonly dependencies: SyncHistoryDependencies) { super(app); }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("mineral-sync-history");
    this.contentEl.createEl("h2", { text: "Mineral Sync History" });
    const loading = this.contentEl.createEl("p", { text: "Loading history…", cls: "mineral-sync-history__notice" });
    try { this.entries = await this.dependencies.list(); }
    catch { this.entries = []; }
    loading.remove();
    this.render();
  }

  onClose(): void { this.contentEl.empty(); }

  private render(): void {
    this.contentEl.empty();
    if (this.page === "detail" && this.selected) { this.renderDetail(this.selected); return; }
    if (this.page === "confirm" && this.pending) { this.renderConfirm(this.pending); return; }
    this.renderList();
  }

  /** Page A: what happened, newest first, grouped by the day it happened on. */
  private renderList(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Mineral Sync History" });
    if (this.notice) contentEl.createEl("p", { text: this.notice, cls: "mineral-sync-history__notice" });
    if (!this.entries.length) {
      contentEl.createEl("p", { text: "No history yet.", cls: "mineral-sync-history__empty" });
      return;
    }

    const now = Date.now();
    let heading = "";
    for (const entry of this.entries) {
      const day = dayKey(entry.timestamp);
      if (day !== heading) {
        heading = day;
        contentEl.createEl("h3", { text: dayLabel(entry.timestamp, now), cls: "mineral-sync-history__day" });
      }
      this.listRow(contentEl, entry);
    }
  }

  private listRow(parent: HTMLElement, entry: SyncHistoryEntry): void {
    const row = parent.createDiv({ cls: "mineral-sync-history__row" });
    row.createSpan({ text: clockTime(entry.timestamp), cls: "mineral-sync-history__time" });
    const body = row.createDiv({ cls: "mineral-sync-history__body" });
    body.createEl("p", { text: truncatePath(entry.path), cls: "mineral-sync-history__path" });
    body.createEl("p", { text: describeHistoryEntry(entry), cls: "mineral-sync-history__description" });
    const evidence = describeHistoryEvidence(entry);
    if (evidence) body.createEl("p", { text: evidence, cls: "mineral-sync-history__evidence" });
    this.button(row, "View", () => { this.selected = entry; this.page = "detail"; this.expanded = false; this.render(); });
  }

  /** Page B: the version that landed, the versions it replaced, and the facts behind the decision. */
  private renderDetail(entry: SyncHistoryEntry): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Mineral Sync History" });
    contentEl.createEl("h3", { text: entry.path, cls: "mineral-sync-history__path" });
    contentEl.createEl("p", { text: describeHistoryEntry(entry), cls: "mineral-sync-history__description" });
    contentEl.createEl("p", { text: new Date(entry.timestamp).toLocaleString(), cls: "mineral-sync-history__time-full" });
    this.result(contentEl, entry);
    this.before(contentEl, entry);
    this.technical(contentEl, entry);

    const actions = contentEl.createDiv({ cls: "mineral-sync-history__actions" });
    this.button(actions, "Back", () => { this.selected = undefined; this.page = "list"; this.expanded = false; this.render(); });
  }

  private result(parent: HTMLElement, entry: SyncHistoryEntry): void {
    const section = parent.createDiv({ cls: "mineral-sync-history__result" });
    section.createEl("p", { text: "Result", cls: "mineral-sync-history__section-title" });
    const text = entry.result.content;
    const truncated = !this.expanded && text.length > PREVIEW_LIMIT;
    section.createEl("pre", { text: truncated ? text.slice(0, PREVIEW_LIMIT) : text, cls: "mineral-sync-history__preview" });
    if (truncated) this.button(section, "Show full text", () => { this.expanded = true; this.render(); });
  }

  /**
   * The versions the merge replaced. Only the ones that exist are offered: a clean auto-merge has both,
   * a restore has neither, and an absent side must not be presented as an empty file to restore.
   */
  private before(parent: HTMLElement, entry: SyncHistoryEntry): void {
    const sides: Array<{ label: string; snapshot: SyncHistorySnapshot }> = [];
    if (entry.localBefore) sides.push({ label: "This device", snapshot: entry.localBefore });
    if (entry.remoteBefore) sides.push({ label: "Other version", snapshot: entry.remoteBefore });
    if (!sides.length) return;

    const section = parent.createDiv({ cls: "mineral-sync-history__before" });
    section.createEl("p", { text: "Before merge", cls: "mineral-sync-history__section-title" });
    for (const side of sides) {
      const block = section.createDiv({ cls: "mineral-sync-history__before-side" });
      block.createEl("p", { text: side.label, cls: "mineral-sync-history__before-label" });
      block.createEl("p", { text: sizeLabel(side.snapshot.size), cls: "mineral-sync-history__before-facts" });
      this.button(block, "Restore this version", () => {
        this.pending = { entry, snapshot: side.snapshot };
        this.page = "confirm";
        this.render();
      });
    }
  }

  /** Page C: the confirmation. It states what will happen, and nothing is written before `Restore`. */
  private renderConfirm(pending: { entry: SyncHistoryEntry; snapshot: SyncHistorySnapshot }): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Mineral Sync History" });
    const body = contentEl.createDiv({ cls: "mineral-sync-history__confirm" });
    body.createEl("h3", { text: "Restore this version?" });
    body.createEl("p", { text: `This will make this historical snapshot the current version of ${pending.entry.path}.` });
    body.createEl("p", { text: "A new sync version will be created. Current history will not be deleted." });

    const actions = contentEl.createDiv({ cls: "mineral-sync-history__actions" });
    this.button(actions, "Restore", () => void this.restore(), true);
    this.button(actions, "Cancel", () => { this.pending = undefined; this.page = "detail"; this.render(); });
  }

  private async restore(): Promise<void> {
    const pending = this.pending;
    if (!pending || this.restoring) return;
    this.restoring = true;
    try {
      // The only write this modal can cause, and it goes through the injected sync path, not the Vault.
      await this.dependencies.restore({ path: pending.entry.path, content: pending.snapshot.content, sourceHistoryId: pending.entry.id });
    } catch {
      new Notice("Mineral Sync: the version could not be restored.");
      return;
    } finally {
      this.restoring = false;
    }

    this.dependencies.debug?.(`history restore applied source=${pending.entry.id}`);
    this.pending = undefined;
    this.selected = undefined;
    this.expanded = false;
    this.notice = "Version restored. It will sync like any other change.";
    this.page = "list";
    this.render();
  }

  /**
   * Every raw fact, collapsed and never needed to use the viewer. Hashes, etags, merge policy and the
   * raw ancestor live here so no other page has to carry them.
   */
  private technical(parent: HTMLElement, entry: SyncHistoryEntry): void {
    const details = parent.createEl("details", { cls: "mineral-sync-history__technical" });
    details.createEl("summary", { text: "Technical details" });
    this.facts(details, "History ID", entry.id);
    this.facts(details, "Event", entry.type);
    this.snapshot(details, "Base", entry.base);
    this.snapshot(details, "This device before", entry.localBefore);
    this.snapshot(details, "Other version before", entry.remoteBefore);
    this.snapshot(details, "Previous current", entry.previousCurrent);
    this.snapshot(details, "Result", entry.result);
    for (const [key, value] of Object.entries(entry.metadata)) this.facts(details, key, String(value));

    const base = details.createDiv({ cls: "mineral-sync-history__technical-row" });
    base.createEl("strong", { text: "Raw base text" });
    base.createEl("pre", { text: entry.base?.content ?? "(no ancestor was recorded)" });
  }

  private facts(parent: HTMLElement, label: string, value: string): void {
    const row = parent.createDiv({ cls: "mineral-sync-history__technical-row" });
    row.createEl("strong", { text: label });
    row.createEl("pre", { text: value });
  }

  private snapshot(parent: HTMLElement, label: string, snapshot: SyncHistorySnapshot | undefined): void {
    this.facts(parent, label, snapshot ? snapshotFacts(snapshot) : "(not recorded)");
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, primary = false): void {
    const element = parent.createEl("button", { text: label, cls: primary ? "mod-cta" : undefined });
    element.addEventListener("click", onClick);
  }
}
