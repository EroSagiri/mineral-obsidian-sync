import { Modal, Setting } from "obsidian";
import { formatReport, summarize } from "./integration/result";
import type { ScenarioReport } from "./integration/result";

/** Development-only report viewer for the R2 integration self-test. */
export class SelfTestReportModal extends Modal {
  constructor(app: import("obsidian").App, private readonly report: ScenarioReport) {
    super(app);
  }

  onOpen(): void {
    const { passed, failed, skipped } = summarize(this.report);
    this.contentEl.createEl("h2", { text: "Mineral Sync — R2 Integration Self-Test (dev)" });
    this.contentEl.createEl("p", { text: `${passed} passed · ${failed} failed · ${skipped} skipped` });
    this.contentEl.createEl("p", { text: `Test root: ${this.report.root} — this run may only touch keys inside that prefix. No canonical R2 key and no personal Vault file was modified.` });

    const textarea = this.contentEl.createEl("textarea");
    textarea.value = formatReport(this.report);
    textarea.rows = 22;
    textarea.style.width = "100%";
    textarea.style.fontFamily = "var(--font-monospace)";
    textarea.style.fontSize = "12px";

    new Setting(this.contentEl).addButton((button) => button.setButtonText("Copy report").onClick(async () => {
      try {
        await navigator.clipboard.writeText(textarea.value);
        button.setButtonText("Copied");
      } catch {
        textarea.select();
      }
    }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
