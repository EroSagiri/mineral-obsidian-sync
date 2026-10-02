import { Notice } from "obsidian";
import type { App } from "obsidian";
import type { R2SyncSettings } from "../settings";
import { HOT_SELF_TEST_FALLBACK_ROOT, runHotSelfTest } from "./integration/hot-scenarios";
import type { HotSelfTestHost } from "./integration/hot-scenarios";
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
 * `.mineral-sync-test/<run-id>/` behind a hard prefix guard. The hot command adds one deliberate
 * exception to that prefix: its protocol group lives under `.mineral/selftest/<run-id>/`, which
 * the sync filter ignores — a hot scratch note must not be a cold-sync candidate, or an ordinary
 * upload could land between the room's acquisition and its first checkpoint.
 */

const REPORT_FILENAME = "last-self-test-report.txt";
const HOT_REPORT_FILENAME = "last-hot-self-test-report.txt";

/** The narrow plugin surface the diagnostics need, so plugin internals stay private. */
export interface SelfTestHost {
  app: App;
  settings: R2SyncSettings;
  /** The plugin's own directory, used only to drop the report file next to `data.json`. */
  pluginDir?: string;
  addCommand(command: { id: string; name: string; callback: () => void }): unknown;
  setStatus(text: string): void;
  /** The live hot layer, so the wiring scenario can observe the production coordinator. */
  /** Present in the host's hot surface; used by the configuration scenario to report why it did not start. */
  hot?: HotSelfTestHost["hot"];
}

export function registerDevelopmentSelfTests(host: SelfTestHost, markerPoll?: { attempts?: number; delayMs?: number }): void {
  host.addCommand({ id: "r2-sync-dev-transport-self-test", name: "Mineral Sync (dev): R2 Transport Self-Test", callback: () => void runSelfTest(host, { transport: true, convergence: false }) });
  host.addCommand({ id: "r2-sync-dev-convergence-self-test", name: "Mineral Sync (dev): R2 Convergence Self-Test", callback: () => void runSelfTest(host, { transport: false, convergence: true }) });
  host.addCommand({ id: "r2-sync-dev-hot-self-test", name: "Mineral Sync (dev): Hot Sync Self-Test", callback: () => void runHot(host) });
  void runMarkerRequestedSelfTest(host, markerPoll ?? {});
}

/**
 * A self-test a human cannot tap on.
 *
 * A phone on a desk is locked, and a locked phone cannot open a command palette — which makes the
 * most valuable check in this whole feature ("does the hot path work on a real Android device?") the
 * one that is hardest to run. So the harness also accepts a *file* as the trigger: drop
 * `<root>RUN-HOT-SELFTEST.md` into the integration root with `adb push`, launch Obsidian, and read the
 * report off the device. No taps, no screenshots, no console.
 *
 * The marker is consumed (deleted) before the run so a crash cannot turn into a loop, and this whole
 * module is replaced by an empty stub in production builds — a released plugin has no marker, no
 * trigger, and no self-test code at all.
 *
 * The lookup *polls* rather than checking once. `onload` runs before a mobile vault is necessarily
 * ready to answer for a file that was pushed onto the filesystem a moment earlier, and a single missed
 * check is indistinguishable from "no marker was requested" — which is exactly the failure that left a
 * device run hanging with the marker still sitting there.
 */
/**
 * The markers a device run is triggered by, in priority order.
 *
 * The `.md` one comes first on purpose. On Android, Obsidian's adapter answers for paths it knows
 * about, and an extensionless file pushed onto the filesystem from outside the app is not one of them:
 * `adapter.exists()` reports `false` for it forever, which looks exactly like "nobody asked for a
 * self-test" — the way a device run ends up sitting there with its marker untouched. A `.md` file is
 * indexed, and the prefix is in the sync filter's built-in exclusions, so it can never become one of the
 * user's notes. The extensionless name is still accepted, for a tool that was already deployed.
 */
const SELF_TEST_MARKERS = [`${HOT_SELF_TEST_FALLBACK_ROOT}RUN-HOT-SELFTEST.md`, `${HOT_SELF_TEST_FALLBACK_ROOT}RUN-HOT-SELFTEST`];

async function runMarkerRequestedSelfTest(host: SelfTestHost, options: { attempts?: number; delayMs?: number } = {}): Promise<void> {
  const attempts = options.attempts ?? 15;
  const delayMs = options.delayMs ?? 2_000;
  try {
    const adapter = host.app.vault.adapter;
    let marker: string | undefined;
    for (let attempt = 0; attempt < attempts && marker === undefined; attempt++) {
      for (const candidate of SELF_TEST_MARKERS) {
        try {
          if (await adapter.exists(candidate)) { marker = candidate; break; }
        } catch { /* a vault that is not ready yet simply answers nothing */ }
      }
      if (marker === undefined) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    if (marker === undefined) return;
    await adapter.remove(marker);
    await runHot(host);
  } catch (error) {
    console.error("[Mineral Obsidian Sync] marker-requested self-test failed", error instanceof Error ? error.message : "unknown error");
  }
}

/**
 * Leaves the report next to `data.json`, inside the plugin's own directory.
 *
 * Mobile has no readable console: Obsidian's WebView `console.log` does not reach `logcat`, and
 * copying from the report window on a phone is awkward. A file in the plugin directory can be
 * read directly over `adb`, which is how mobile evidence is collected.
 */
async function writeReportFile(host: SelfTestHost, report: ScenarioReport, filename = REPORT_FILENAME): Promise<string | undefined> {
  const dir = host.pluginDir;
  if (!dir) return undefined;
  const path = `${dir}/${filename}`;
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

/**
 * The hot self-test.
 *
 * It is a separate command rather than another scenario of the R2 suite because it needs a real editor
 * and a live server round trip, and because its evidence is what a device check is actually about:
 * the platform's transport, the editor bridge, and the handoff — not the R2 primitives.
 */
async function runHot(host: SelfTestHost): Promise<void> {
  host.setStatus("… hot self-test");
  new Notice("Hot sync self-test running against the configured Gateway …");
  try {
    const run = await runHotSelfTest({ app: host.app, settings: host.settings, ...(host.hot ? { hot: host.hot } : {}) });
    const report: ScenarioReport = {
      runId: run.root,
      root: run.root,
      environment: `obsidian-hot/${host.settings.hotSyncEnabled ? "enabled" : "disabled"}`,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      results: run.results,
    };
    const { passed, failed, skipped } = summarize(report);
    const secrets = [host.settings.accessKeyId, host.settings.secretAccessKey, host.settings.gatewayToken].filter(Boolean);
    const safe = { ...report, results: report.results.map(result => ({ ...result, detail: redact(result.detail, secrets) })) };
    const reportPath = await writeReportFile(host, safe, HOT_REPORT_FILENAME);
    console.log(`[Mineral Obsidian Sync] hot sync self-test\n${formatReport(safe)}${reportPath ? `\n\nreport file: ${reportPath}` : ""}`);
    new SelfTestReportModal(host.app, safe).open();
    host.setStatus(failed ? `! hot self-test ${failed} failed` : "✓ hot self-test passed");
    new Notice(failed ? `Hot self-test: ${failed} scenario(s) failed — open the report window.` : `Hot self-test passed: ${passed} scenario(s), ${skipped} skipped. No canonical key was touched.`);
  } catch (error) {
    const diagnostic = redact(error instanceof Error ? error.message : "unknown error", [host.settings.accessKeyId, host.settings.secretAccessKey, host.settings.gatewayToken]).replace(/\s+/g, " ").slice(0, 180);
    console.error("[Mineral Obsidian Sync] hot self-test aborted", diagnostic);
    host.setStatus("! hot self-test aborted");
    new Notice(`Hot self-test aborted: ${diagnostic}`);
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





