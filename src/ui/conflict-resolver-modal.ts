import { Modal, Notice, Setting, type App } from "obsidian";
import { mergedContentOf, shortConflictId } from "../conflict/identity";
import { CONFLICT_PROTOCOL_VERSION, type ConflictRecord, type ResolutionIntent } from "../conflict/types";

/**
 * The manual conflict resolver.
 *
 * The one rule this file must never break: **the UI does not write data.** It reads snapshots and it
 * persists a `ResolutionIntent`. Every actual file or R2 change is performed later by `SafeExecutor`
 * through the planner, so there is no code path here that could overwrite a note or an object.
 *
 * That is also why the modal shows a conflict identity rather than merely a path: a resolution
 * authored against one pair of versions must be visibly tied to those versions.
 */
export interface ConflictResolverDependencies {
  list(): Promise<ConflictRecord[]>;
  /** Persists a resolution intent only; never mutates content. */
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
  private loading = true;

  constructor(app: App, private readonly dependencies: ConflictResolverDependencies) { super(app); }

  async onOpen(): Promise<void> {
    this.contentEl.createEl("h2", { text: "Mineral Sync — Conflicts" });
    const loading = this.contentEl.createEl("p", { text: "Loading conflicts…" });
    try { this.records = await this.dependencies.list(); }
    catch { this.records = []; }
    loading.remove();
    this.loading = false;
    if (!this.records.length) {
      this.contentEl.createEl("p", { text: "No sync conflicts." });
      return;
    }
    this.render();
  }

  onClose(): void { this.contentEl.empty(); }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Mineral Sync — Conflicts" });
    const record = this.records[this.index];
    if (!record) return;

    if (this.records.length > 1) {
      new Setting(contentEl).setName(`Conflict ${this.index + 1} of ${this.records.length}`).addButton((button) => button.setButtonText("Next").onClick(() => { this.index = (this.index + 1) % this.records.length; this.draft = undefined; this.render(); }));
    }

    contentEl.createEl("h3", { text: record.path });
    const detected = new Date(record.detectedAt).toLocaleString();
    contentEl.createEl("p", { text: `Detected ${detected} · conflict ${shortConflictId(record.conflictId)} · remote ETag ${record.observedRemoteETag ? shortConflictId(record.observedRemoteETag) : "unknown"} · auto-merge: ${record.autoMergeStatus}` });

    // The base panel tells the truth about a missing snapshot instead of inventing content.
    if (!record.snapshot.baseAvailable) {
      const warning = contentEl.createEl("p", { text: "Merge base unavailable for this conflict. This conflict predates merge-base snapshots, so a three-way merge is not possible here. Compare the two sides and edit the result yourself." });
      warning.style.color = "var(--text-warning)";
      warning.style.fontWeight = "600";
    }
    if (record.reason) contentEl.createEl("p", { text: `Reason: ${record.reason}` });

    const panels = contentEl.createDiv();
    panels.style.display = "grid";
    panels.style.gridTemplateColumns = "1fr 1fr";
    panels.style.gap = "8px";
    this.panel(panels, "Base", record.snapshot.baseAvailable ? (record.snapshot.base ?? "") : "— unavailable —");
    this.panel(panels, "Local", record.snapshot.local ?? "");
    this.panel(panels, "Remote", record.snapshot.remote ?? "");
    this.panel(panels, this.draft ? "Merged (editing)" : "Merged", this.draft?.text ?? record.snapshot.draft ?? "");

    const actions = contentEl.createDiv();
    actions.style.marginTop = "12px";
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.flexWrap = "wrap";

    this.button(actions, "Keep Local", () => this.apply("keep-local"));
    this.button(actions, "Keep Remote", () => this.apply("keep-remote"));
    this.button(actions, this.draft ? "Apply Merged" : "Edit Merged Result", () => this.editMerged(record));
  }

  private panel(parent: HTMLElement, title: string, text: string): void {
    const wrapper = parent.createDiv();
    wrapper.createEl("strong", { text: title });
    const pre = wrapper.createEl("pre", { text });
    pre.style.maxHeight = "240px";
    pre.style.overflow = "auto";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.border = "1px solid var(--background-modifier-border)";
    pre.style.padding = "8px";
    pre.style.margin = "4px 0 0";
  }

  private button(parent: HTMLElement, label: string, onClick: () => void): void {
    const element = parent.createEl("button", { text: label });
    element.addEventListener("click", onClick);
  }

  /**
   * Collecting an explicit choice. The default draft for a conflict without a clean merge is the
   * **local** content, because overwriting the user's own text with a marker-laden draft would be a
   * destructive default; the user is expected to consult the remote panel next to it.
   */
  private editMerged(record: ConflictRecord): void {
    if (!this.draft) this.draft = { path: record.path, text: record.snapshot.draft ?? record.snapshot.local ?? "" };
    const container = this.contentEl;
    container.empty();
    container.createEl("h2", { text: `Edit merged result — ${record.path}` });
    if (!record.snapshot.baseAvailable) container.createEl("p", { text: "Merge base unavailable: this is a manual merge. These conflict markers, if any, are only a draft and are never written to your note until you press Apply." });
    const editor = container.createEl("textarea");
    editor.value = this.draft.text;
    editor.rows = 20;
    editor.style.width = "100%";
    editor.style.fontFamily = "var(--font-monospace)";
    editor.addEventListener("input", () => { this.draft = { path: record.path, text: editor.value }; });
    const actions = container.createDiv();
    actions.style.marginTop = "12px";
    this.button(actions, "Back", () => this.render());
    this.button(actions, "Apply", () => { this.draft = { path: record.path, text: editor.value }; void this.apply("merged"); });
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
    else { this.contentEl.empty(); this.contentEl.createEl("p", { text: "No sync conflicts." }); }
  }
}
