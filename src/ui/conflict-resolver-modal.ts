import { Modal, Notice, type App } from "obsidian";
import { mergedContentOf, shortConflictId } from "../conflict/identity";
import { CONFLICT_PROTOCOL_VERSION, type ConflictRecord, type ResolutionIntent } from "../conflict/types";
import {
  presentConflict,
  type ConflictPresentation,
  type DifferenceView,
  type TechnicalEntry,
} from "./conflict-presentation";

/**
 * The manual conflict resolver.
 *
 * The user is not here to perform a merge. Mineral either has a result prepared, in which case the job
 * is to review it and accept it, or it does not, in which case the job is to write one. The screens
 * follow that order:
 *
 * - **the result page** asks one question ("is this the result you want?") and offers exactly one
 *   primary action plus two quiet alternatives;
 * - **the differences page** is the only place two sides are shown side by side, and the only place the
 *   overwrite-the-other-side actions live, so a destructive choice is never next to the recommended one;
 * - **the edit page** works on the final text, never on conflict markers;
 * - **Technical details** is collapsed and is never needed to finish.
 *
 * The rule this file must never break is unchanged: **the UI does not write data.** It renders a view
 * and persists a `ResolutionIntent`; every file and R2 change is performed later by `SafeExecutor`
 * through the planner.
 */
export interface ConflictResolverDependencies {
  list(): Promise<ConflictRecord[]>;
  /** Persists a resolution intent only; never mutates content. */
  propose(intent: ResolutionIntent, reason: "conflict-auto-merge" | "conflict-manual-resolution"): Promise<void>;
  /** Exposed so a test can assert that the UI never reaches for a transport or the Vault. */
  debug?(message: string): void;
}

type Draft = { path: string; text: string };
type Page = "result" | "differences" | "edit";

export class ConflictResolverModal extends Modal {
  private records: ConflictRecord[] = [];
  private index = 0;
  private page: Page = "result";
  private draft?: Draft;
  /** The queue size when the resolver opened, so progress stays readable while it shrinks. */
  private total = 0;
  private resolved = 0;

  constructor(app: App, private readonly dependencies: ConflictResolverDependencies) { super(app); }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("mineral-sync-conflicts");
    this.contentEl.createEl("h2", { text: "Mineral Sync" });
    const loading = this.contentEl.createEl("p", { text: "Loading conflicts…" });
    try { this.records = await this.dependencies.list(); }
    catch { this.records = []; }
    loading.remove();
    this.total = this.records.length;
    this.resolved = 0;
    this.render();
  }

  onClose(): void { this.contentEl.empty(); }

  private get record(): ConflictRecord | undefined { return this.records[this.index]; }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Mineral Sync" });
    const record = this.record;
    if (!record) {
      contentEl.createEl("p", { text: "All conflicts resolved", cls: "mineral-sync-conflicts__headline" });
      const actions = contentEl.createDiv({ cls: "mineral-sync-conflicts__actions" });
      this.button(actions, "Done", () => this.close(), true);
      return;
    }

    const view = presentConflict(record);
    contentEl.createEl("h3", { text: view.path, cls: "mineral-sync-conflicts__path" });
    if (this.total > 1) {
      const pager = contentEl.createDiv({ cls: "mineral-sync-conflicts__pager" });
      pager.createSpan({ text: `${this.total} conflicts need attention`, cls: "mineral-sync-conflicts__count" });
      // Progress through the queue, so resolving one reads as "next", not as a fresh problem.
      pager.createSpan({ text: `${this.resolved + this.index + 1} of ${this.total}`, cls: "mineral-sync-conflicts__count" });
      this.button(pager, "Previous", () => this.step(-1));
      this.button(pager, "Next", () => this.step(1));
    }

    if (view.kind === "delete-vs-modify") { this.renderDeleteVersusModify(contentEl, view); return; }
    if (this.page === "differences") { this.renderDifferences(contentEl, view); return; }
    if (this.page === "edit") { this.renderEdit(contentEl, record, view); return; }
    this.renderResult(contentEl, view);
  }

  private step(delta: number): void {
    this.index = (this.index + delta + this.records.length) % this.records.length;
    this.draft = undefined;
    this.page = "result";
    this.render();
  }

  /** Page A and B: the suggested result, or the admission that there is none. */
  private renderResult(parent: HTMLElement, view: Extract<ConflictPresentation, { kind: "suggested" | "manual" }>): void {
    parent.createEl("p", { text: view.summary, cls: "mineral-sync-conflicts__headline" });
    if (view.kind === "manual") {
      parent.createEl("p", { text: "This change could not be merged automatically.", cls: "mineral-sync-conflicts__headline" });
      if (view.notice) parent.createEl("p", { text: view.notice, cls: "mineral-sync-conflicts__notice" });
    } else {
      const block = parent.createDiv({ cls: "mineral-sync-conflicts__preview" });
      block.createEl("p", { text: view.label, cls: "mineral-sync-conflicts__hunk-title" });
      block.createEl("pre", { text: view.suggestedText, cls: "mineral-sync-conflicts__result" });
    }

    const actions = parent.createDiv({ cls: "mineral-sync-conflicts__actions" });
    if (view.kind === "suggested") {
      this.button(actions, "Use suggested result", () => { this.draft = { path: view.path, text: view.suggestedText }; void this.apply("merged"); }, true);
      this.button(actions, "View differences", () => { this.page = "differences"; this.render(); });
      this.button(actions, "Edit manually", () => { this.page = "edit"; this.render(); });
    } else {
      // With nothing trustworthy prepared, writing the result is the primary path, not a fallback.
      this.button(actions, "Edit manually", () => { this.page = "edit"; this.render(); }, true);
      this.button(actions, "View differences", () => { this.page = "differences"; this.render(); });
    }
    this.technical(parent, view.technical);
  }

  /**
   * Page C: a deletion against an edit is not a merge, so it gets its own words and its own two
   * decisions. "Keep note" is primary because it is the recoverable one.
   */
  private renderDeleteVersusModify(parent: HTMLElement, view: Extract<ConflictPresentation, { kind: "delete-vs-modify" }>): void {
    parent.createEl("p", { text: view.explanation, cls: "mineral-sync-conflicts__headline" });
    const block = parent.createDiv({ cls: "mineral-sync-conflicts__preview" });
    block.createEl("p", { text: "Modified version", cls: "mineral-sync-conflicts__hunk-title" });
    block.createEl("pre", { text: view.modifiedText, cls: "mineral-sync-conflicts__result" });
    const actions = parent.createDiv({ cls: "mineral-sync-conflicts__actions" });
    const keep = view.deletedSide === "other"
      ? { type: "keep-local" as const, label: "Keep note" }
      : { type: "keep-remote" as const, label: "Keep note" };
    const remove = view.deletedSide === "other"
      ? { type: "accept-remote-delete" as const, label: "Delete note" }
      : { type: "accept-local-delete" as const, label: "Delete note" };
    this.button(actions, keep.label, () => void this.apply(keep.type), true);
    this.button(actions, remove.label, () => void this.apply(remove.type));
    this.technical(parent, view.technical);
  }

  /**
   * The second layer: the only screen that asks the user to compare anything, and the only one where
   * overwriting a side is offered. Base is deliberately absent — it belongs to technical details.
   */
  private renderDifferences(parent: HTMLElement, view: Extract<ConflictPresentation, { kind: "suggested" | "manual" }>): void {
    parent.createEl("p", { text: "Differences", cls: "mineral-sync-conflicts__headline" });
    if (!view.differences.length) {
      parent.createEl("p", { text: "The two versions have no line-level difference.", cls: "mineral-sync-conflicts__notice" });
    } else if (view.differencesAreNoise) {
      parent.createEl("p", { text: "The two versions differ only in formatting — line endings, trailing spaces or the final newline.", cls: "mineral-sync-conflicts__notice" });
    }
    for (const difference of view.differences) {
      if (difference.kind === "formatting-only") continue;
      this.difference(parent, difference);
    }

    const actions = parent.createDiv({ cls: "mineral-sync-conflicts__actions" });
    this.button(actions, "Use current version", () => void this.apply("keep-local"));
    this.button(actions, "Use other version", () => void this.apply("keep-remote"));
    this.button(actions, "Edit manually", () => { this.page = "edit"; this.render(); });
    this.button(actions, view.kind === "suggested" ? "Back to suggested result" : "Back", () => { this.page = "result"; this.render(); });
    this.technical(parent, view.technical);
  }

  private difference(parent: HTMLElement, difference: DifferenceView): void {
    const section = parent.createDiv({ cls: `mineral-sync-conflicts__hunk mineral-sync-conflicts__hunk--${difference.kind}` });
    section.createEl("p", { text: difference.title, cls: "mineral-sync-conflicts__hunk-title" });
    if (difference.contextBefore) section.createEl("pre", { text: difference.contextBefore, cls: "mineral-sync-conflicts__context" });
    if (difference.kind === "current-only" || difference.kind === "other-only") {
      const only = difference.kind === "current-only";
      const column = section.createDiv({ cls: "mineral-sync-conflicts__side mineral-sync-conflicts__side--changed" });
      column.createEl("p", { text: only ? difference.currentHeading : difference.otherHeading, cls: "mineral-sync-conflicts__side-heading" });
      column.createEl("pre", { text: only ? difference.current : difference.other, cls: "mineral-sync-conflicts__side-body" });
    } else {
      const columns = section.createDiv({ cls: "mineral-sync-conflicts__columns" });
      this.side(columns, difference.currentHeading, difference.current, "current");
      this.side(columns, difference.otherHeading, difference.other, "other");
    }
    if (difference.note) section.createEl("p", { text: difference.note, cls: "mineral-sync-conflicts__notice" });
    if (difference.contextAfter) section.createEl("pre", { text: difference.contextAfter, cls: "mineral-sync-conflicts__context" });
  }

  private side(parent: HTMLElement, heading: string, text: string, kind: "current" | "other"): void {
    const column = parent.createDiv({ cls: `mineral-sync-conflicts__side mineral-sync-conflicts__side--${kind}` });
    column.createEl("p", { text: heading, cls: "mineral-sync-conflicts__side-heading" });
    column.createEl("pre", { text, cls: "mineral-sync-conflicts__side-body" });
  }

  /** The third layer: the final text, with no markers anywhere near it. */
  private renderEdit(parent: HTMLElement, record: ConflictRecord, view: Extract<ConflictPresentation, { kind: "suggested" | "manual" }>): void {
    if (!this.draft) {
      const fallback = view.kind === "suggested" ? view.suggestedText : view.draftText;
      this.draft = { path: record.path, text: fallback };
    }
    parent.createEl("p", { text: "Edit final result", cls: "mineral-sync-conflicts__headline" });
    parent.createEl("p", { text: "Nothing is written until you apply it.", cls: "mineral-sync-conflicts__notice" });
    const editor = parent.createEl("textarea", { cls: "mineral-sync-conflicts__editor" });
    editor.value = this.draft.text;
    editor.rows = 18;
    editor.addEventListener("input", () => { this.draft = { path: record.path, text: editor.value }; });
    const actions = parent.createDiv({ cls: "mineral-sync-conflicts__actions" });
    this.button(actions, "Apply resolved version", () => { this.draft = { path: record.path, text: editor.value }; void this.apply("merged"); }, true);
    this.button(actions, "Cancel", () => { this.page = "result"; this.render(); });
    this.button(actions, "View differences", () => { this.page = "differences"; this.render(); });
    this.technical(parent, view.technical);
  }

  private technical(parent: HTMLElement, entries: TechnicalEntry[]): void {
    const details = parent.createEl("details", { cls: "mineral-sync-conflicts__technical" });
    details.createEl("summary", { text: "Technical details" });
    for (const entry of entries) {
      const row = details.createDiv({ cls: "mineral-sync-conflicts__technical-row" });
      row.createEl("strong", { text: entry.label });
      row.createEl("pre", { text: entry.value });
    }
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, primary = false): void {
    const element = parent.createEl("button", { text: label, cls: primary ? "mod-cta" : undefined });
    element.addEventListener("click", onClick);
  }

  private async apply(type: ResolutionIntent["type"]): Promise<void> {
    const record = this.record;
    if (!record) return;
    // No content is written here. Only an intent, bound to the exact versions on screen.
    const intent: ResolutionIntent = {
      protocolVersion: CONFLICT_PROTOCOL_VERSION,
      conflictId: record.conflictId,
      channel: record.channel,
      path: record.path,
      type,
      expectedLocalVersion: record.observedLocal,
      expectedRemoteETag: record.observedRemoteETag,
      expectedRemoteDeletion: record.observedRemoteDeletion,
      createdAt: Date.now(),
      // A person made this decision, which is what distinguishes its history entry from an auto-merge.
      origin: "manual",
    };
    try {
      if (type === "merged" && this.draft) intent.merged = await mergedContentOf(this.draft.text);
      await this.dependencies.propose(intent, "conflict-manual-resolution");
    }
    catch { new Notice("Mineral Sync: the resolution could not be recorded."); return; }
    this.dependencies.debug?.(`conflict resolution requested type=${type} path-hash=${shortConflictId(record.conflictId)}`);
    new Notice("Mineral Sync: resolution recorded. It will be applied on the next reconciliation.");
    // The next conflict is shown immediately, from its own result page: no trip back to a list.
    this.draft = undefined;
    this.page = "result";
    this.records = this.records.filter((candidate) => candidate.conflictId !== record.conflictId);
    this.resolved += 1;
    if (this.index >= this.records.length) this.index = 0;
    this.render();
  }
}
