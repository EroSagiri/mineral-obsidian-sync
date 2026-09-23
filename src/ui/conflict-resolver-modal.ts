import { Modal, Notice, type App } from "obsidian";
import { mergedContentOf, shortConflictId } from "../conflict/identity";
import { CONFLICT_PROTOCOL_VERSION, type ConflictRecord, type ResolutionIntent } from "../conflict/types";
import { presentConflict, type ConflictActionView, type ConflictView } from "./conflict-presentation";

/**
 * The manual conflict resolver.
 *
 * The one rule this file must never break: **the UI does not write data.** It reads snapshots, renders
 * a view, and persists a `ResolutionIntent`. Every actual file or R2 change is performed later by
 * `SafeExecutor` through the planner, so there is no code path here that could overwrite a note or an
 * object.
 *
 * Beyond that it is deliberately not a diff tool. The default screen shows the disagreeing region, the
 * two sides named by role, and the decisions a person would actually make; the common ancestor, the
 * ETags, the conflict identity and the raw marker draft exist, but only inside a collapsed
 * "Technical details" block. Reading a Git conflict is not a prerequisite for resolving one.
 */
export interface ConflictResolverDependencies {
  list(): Promise<ConflictRecord[]>;
  /** Persists a resolution intent only; never mutates content. */
  propose(intent: ResolutionIntent, reason: "conflict-auto-merge" | "conflict-manual-resolution"): Promise<void>;
  /** Exposed so a test can assert that the UI never reaches for a transport or the Vault. */
  debug?(message: string): void;
}

type Draft = { path: string; text: string };

export class ConflictResolverModal extends Modal {
  private records: ConflictRecord[] = [];
  private index = 0;
  private draft?: Draft;

  constructor(app: App, private readonly dependencies: ConflictResolverDependencies) { super(app); }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("mineral-sync-conflicts");
    this.contentEl.createEl("h2", { text: "Mineral Sync" });
    const loading = this.contentEl.createEl("p", { text: "Loading conflicts…" });
    try { this.records = await this.dependencies.list(); }
    catch { this.records = []; }
    loading.remove();
    this.render();
  }

  onClose(): void { this.contentEl.empty(); }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Mineral Sync" });
    const record = this.records[this.index];
    if (!record) { contentEl.createEl("p", { text: "No conflicts — everything is in sync." }); return; }

    const view = presentConflict(record);
    contentEl.createEl("h3", { text: view.path, cls: "mineral-sync-conflicts__path" });
    contentEl.createEl("p", { text: view.headline, cls: "mineral-sync-conflicts__headline" });
    if (this.records.length > 1) this.renderPager(contentEl);
    if (view.notice) contentEl.createEl("p", { text: view.notice, cls: "mineral-sync-conflicts__notice" });

    for (const hunk of view.hunks) {
      const section = contentEl.createDiv({ cls: "mineral-sync-conflicts__hunk" });
      section.createEl("p", { text: hunk.title, cls: "mineral-sync-conflicts__hunk-title" });
      if (hunk.contextBefore) section.createEl("pre", { text: hunk.contextBefore, cls: "mineral-sync-conflicts__context" });
      const columns = section.createDiv({ cls: "mineral-sync-conflicts__columns" });
      this.side(columns, hunk.currentHeading, hunk.current, "current");
      this.side(columns, hunk.otherHeading, hunk.other, "other");
      if (hunk.contextAfter) section.createEl("pre", { text: hunk.contextAfter, cls: "mineral-sync-conflicts__context" });
    }

    // Only shown when keeping both is a real answer, which is the case this UI exists to make obvious.
    if (view.keepBothText !== undefined) {
      const preview = contentEl.createDiv({ cls: "mineral-sync-conflicts__preview" });
      preview.createEl("p", { text: "Result if you keep both:", cls: "mineral-sync-conflicts__hunk-title" });
      preview.createEl("pre", { text: view.keepBothText, cls: "mineral-sync-conflicts__result" });
    }

    const actions = contentEl.createDiv({ cls: "mineral-sync-conflicts__actions" });
    for (const action of view.actions) this.action(actions, action, view);
    this.technical(contentEl, view);
  }

  private renderPager(parent: HTMLElement): void {
    const nav = parent.createDiv({ cls: "mineral-sync-conflicts__pager" });
    nav.createSpan({ text: `Conflict ${this.index + 1} of ${this.records.length}`, cls: "mineral-sync-conflicts__count" });
    const step = (delta: number): void => {
      this.index = (this.index + delta + this.records.length) % this.records.length;
      this.draft = undefined;
      this.render();
    };
    this.button(nav, "Previous conflict", () => step(-1));
    this.button(nav, "Next conflict", () => step(1));
  }

  private side(parent: HTMLElement, heading: string, text: string, kind: "current" | "other"): void {
    const column = parent.createDiv({ cls: `mineral-sync-conflicts__side mineral-sync-conflicts__side--${kind}` });
    column.createEl("p", { text: heading, cls: "mineral-sync-conflicts__side-heading" });
    column.createEl("pre", { text, cls: "mineral-sync-conflicts__side-body" });
  }

  private action(parent: HTMLElement, action: ConflictActionView, view: ConflictView): void {
    const record = this.records[this.index];
    if (!record) return;
    this.button(parent, action.label, () => {
      if (action.id === "edit") { this.editResult(record, view); return; }
      // "Keep both" is the merge the preview showed; it is proposed as an explicit merged result so the
      // executor never has to invent it.
      if (action.intent === "merged" && view.keepBothText !== undefined) { this.draft = { path: record.path, text: view.keepBothText }; }
      if (action.intent) void this.apply(action.intent);
    }, action.primary);
  }

  private technical(parent: HTMLElement, view: ConflictView): void {
    const details = parent.createEl("details", { cls: "mineral-sync-conflicts__technical" });
    details.createEl("summary", { text: "Technical details" });
    for (const entry of view.technical) {
      const row = details.createDiv({ cls: "mineral-sync-conflicts__technical-row" });
      row.createEl("strong", { text: entry.label });
      row.createEl("pre", { text: entry.value });
    }
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, primary = false): void {
    const element = parent.createEl("button", { text: label, cls: primary ? "mod-cta" : undefined });
    element.addEventListener("click", onClick);
  }

  /**
   * The manual editor works on the *result*, not on a diff. It opens with both sides already present,
   * so the user removes what they do not want instead of resolving markers, and it is only reachable by
   * asking for it.
   */
  private editResult(record: ConflictRecord, view: ConflictView): void {
    if (!this.draft) this.draft = { path: record.path, text: view.resultText };
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Mineral Sync" });
    contentEl.createEl("h3", { text: record.path, cls: "mineral-sync-conflicts__path" });
    contentEl.createEl("p", { text: "Edit the result you want. Nothing is written until you apply it.", cls: "mineral-sync-conflicts__headline" });
    const editor = contentEl.createEl("textarea", { cls: "mineral-sync-conflicts__editor" });
    editor.value = this.draft.text;
    editor.rows = 18;
    editor.addEventListener("input", () => { this.draft = { path: record.path, text: editor.value }; });
    const actions = contentEl.createDiv({ cls: "mineral-sync-conflicts__actions" });
    this.button(actions, "Cancel", () => this.render());
    this.button(actions, "Apply resolved version", () => { this.draft = { path: record.path, text: editor.value }; void this.apply("merged"); }, true);
    this.technical(contentEl, presentConflict(record));
  }

  private async apply(type: ResolutionIntent["type"]): Promise<void> {
    const record = this.records[this.index];
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
    };
    try {
      if (type === "merged" && this.draft) intent.merged = await mergedContentOf(this.draft.text);
      await this.dependencies.propose(intent, "conflict-manual-resolution");
    }
    catch { new Notice("Mineral Sync: the resolution could not be recorded."); return; }
    this.dependencies.debug?.(`conflict resolution requested type=${type} path-hash=${shortConflictId(record.conflictId)}`);
    new Notice("Mineral Sync: resolution recorded. It will be applied on the next reconciliation.");
    this.draft = undefined;
    this.records = this.records.filter((candidate) => candidate.conflictId !== record.conflictId);
    if (this.records.length) { this.index = Math.min(this.index, this.records.length - 1); this.render(); }
    else { this.contentEl.empty(); this.contentEl.createEl("h2", { text: "Mineral Sync" }); this.contentEl.createEl("p", { text: "No conflicts — everything is in sync." }); }
  }
}
