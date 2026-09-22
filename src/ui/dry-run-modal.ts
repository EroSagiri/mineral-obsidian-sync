import { Modal } from "obsidian";
import type { SyncOperation, SyncPlan } from "../sync/types";

const TYPES: SyncOperation["type"][] = ["upload", "download", "delete-local", "delete-remote", "prune-baseline", "resolve-keep-local", "resolve-keep-remote", "resolve-merged", "conflict", "noop"];
const LABELS: Record<SyncOperation["type"], string> = { upload: "Upload", download: "Download", "delete-local": "Move Local To Trash", "delete-remote": "Delete Remote (blocked)", "prune-baseline": "Forget Stale Baseline", "resolve-keep-local": "Resolve: Keep Local", "resolve-keep-remote": "Resolve: Keep Remote", "resolve-merged": "Resolve: Merged", conflict: "Conflict", noop: "Unchanged" };

export class DryRunModal extends Modal {
  constructor(app: import("obsidian").App, private readonly plan: SyncPlan, private readonly counts: { local: number; remote: number; previous: number; bootstrapCandidates: number; verifiedIdentical: number; hashedFiles: number; hashedBytes: number; differentContent: number; unresolved: number }) { super(app); }
  onOpen(): void {
    this.contentEl.createEl("h2", { text: "Mineral Sync Inspection" });
    this.contentEl.createEl("p", { text: `Local ${this.counts.local} · Remote ${this.counts.remote} · Previous ${this.counts.previous}. No Vault or R2 content was changed.` });
    this.contentEl.createEl("p", { text: `Bootstrap candidates ${this.counts.bootstrapCandidates} · Verified identical ${this.counts.verifiedIdentical} · Hashed files ${this.counts.hashedFiles} · Hashed bytes ${this.counts.hashedBytes} · Different content ${this.counts.differentContent} · Unresolved ${this.counts.unresolved}.` });
    for (const type of TYPES) {
      const operations = this.plan.operations.filter((entry) => entry.type === type);
      this.contentEl.createEl("h3", { text: `${LABELS[type]} — ${operations.length}` });
      if (!operations.length) continue;
      const list = this.contentEl.createEl("ul");
      if (type === "delete-local" || type === "delete-remote" || type === "conflict") {
        list.style.color = "var(--text-error)";
        list.style.fontWeight = "600";
      }
      for (const entry of operations) list.createEl("li", { text: entry.type === "conflict" ? `${entry.key} — ${entry.conflict}` : entry.key, attr: { title: entry.reason } });
    }
  }
  onClose(): void { this.contentEl.empty(); }
}
