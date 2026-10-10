import { Notice } from "obsidian";
import type { App } from "obsidian";
import type { R2SyncSettings } from "../settings";
import { formatReport, redact, summarize } from "./integration/result";
import type { ScenarioReport } from "./integration/result";
import { runR2SelfTest } from "./integration/runner";
import type { SelfTestSelection } from "./integration/runner";
import { SelfTestReportModal } from "./report-modal";

/**
 * Development-only entry point.
 *
 * This module is the *only* thing `main.ts` imports from `src/dev`, and `main.ts` calls it
 * from inside `if (__DEV__)`. A production build folds that branch away **and** substitutes an
 * empty stub for this module, so no self-test command, string, or code path can ship.
 *
 * These commands are diagnostics, not synchronization: they are named after the transport,
 * they cannot be triggered from the status bar, and every key they touch is minted inside
 * `.mineral-sync-test/<run-id>/` behind a hard prefix guard.
 */

const REPORT_FILENAME = "last-self-test-report.txt";

/** The narrow plugin surface the diagnostics need, so plugin internals stay private. */
export interface SelfTestHost {
  app: App;
  settings: R2SyncSettings;
  /** The plugin's own directory, used only to drop the report file next to `data.json`. */
  pluginDir?: string;
  addCommand(command: { id: string; name: string; callback: () => void }): unknown;
  setStatus(text: string): void;
}

export function registerDevelopmentSelfTests(host: SelfTestHost): void {
  host.addCommand({ id: "r2-sync-dev-transport-self-test", name: "Mineral Sync (dev): R2 Transport Self-Test", callback: () => void runSelfTest(host, { transport: true, convergence: false }) });
  host.addCommand({ id: "r2-sync-dev-convergence-self-test", name: "Mineral Sync (dev): R2 Convergence Self-Test", callback: () => void runSelfTest(host, { transport: false, convergence: true }) });
}

/**
 * Leaves the report next to `data.json`, inside the plugin's own directory.
 *
 * Mobile has no readable console: Obsidian's WebView `console.log` does not reach `logcat`, and
 * copying from the report window on a phone is awkward. A file in the plugin directory can be
 * read directly over `adb`, which is how mobile evidence is collected.
 */
async function writeReportFile(host: SelfTestHost, report: ScenarioReport): Promise<string | undefined> {
  const dir = host.pluginDir;
  if (!dir) return undefined;
  const path = `${dir}/${REPORT_FILENAME}`;
  try {
    const adapter = host.app.vault.adapter;
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    await adapter.write(path, `${formatReport(report)}\n\n--- raw report ---\n${JSON.stringify(report, null, 2)}\n`);
    return path;
  } catch (error) {
    console.error("[Mineral Obsidian Sync] could not write the self-test report file", error instanceof Error ? error.message : "unknown error");
    return undefined;
  }
}

async function runSelfTest(host: SelfTestHost, selection: SelfTestSelection): Promise<void> {
  host.setStatus("… self-test");
  new Notice("R2 self-test running inside .mineral-sync-test/ …");
  try {
    const report = await runR2SelfTest(host.app, host.settings, selection);
    const { passed, failed, skipped } = summarize(report);
    const reportPath = await writeReportFile(host, report);
    console.log(`[Mineral Obsidian Sync] R2 integration self-test\n${formatReport(report)}${reportPath ? `\n\nreport file: ${reportPath}` : ""}`);
    new SelfTestReportModal(host.app, report).open();
    host.setStatus(failed ? `! self-test ${failed} failed` : "✓ self-test passed");
    new Notice(failed ? `Self-test: ${failed} scenario(s) failed — open the report window.` : `Self-test passed: ${passed} scenario(s), ${skipped} skipped. No canonical R2 key was touched.`);
  } catch (error) {
    const diagnostic = redact(error instanceof Error ? error.message : "unknown error", [host.settings.accessKeyId, host.settings.secretAccessKey]).replace(/\s+/g, " ").slice(0, 180);
    console.error("[Mineral Obsidian Sync] self-test aborted", diagnostic);
    host.setStatus("! self-test aborted");
    new Notice(`Self-test aborted: ${diagnostic}`);
  }
}
