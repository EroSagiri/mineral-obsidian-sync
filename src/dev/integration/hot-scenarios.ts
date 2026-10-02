import type { App, Editor, TFile } from "obsidian";
import { deriveRemoteChangeChannel } from "@mineral/sync-core/channel";
import { hotContentHash } from "@mineral/sync-core/hot-protocol";
import type { R2SyncSettings } from "../../settings";
import { RequestUrlGatewayTransport } from "../../gateway/transport";
import { HotGatewayClient, type HotHttpRequest, type HotHttpResponse, type HotSocket } from "../../hot/client";
import { HotSyncCoordinator } from "../../hot/coordinator";
import { MemoryHotStateStore } from "../../hot/store";
import type { HotBaseline } from "../../hot/types";
import { ensureFolderTree } from "./local-scratch";
import { observation, require, runScenario, ScenarioFailure } from "./result";
import type { ScenarioObservation, ScenarioResult } from "./result";
import { formatRunId } from "./test-namespace";

/**
 * The in-Obsidian hot-sync self-test.
 *
 * Everything else in this repository runs the hot path against fakes, or against Node's `fetch` and
 * `WebSocket`. This is the only route that exercises what the *device* actually does: Obsidian's
 * `requestUrl` transport (the primitive that differs between desktop and the Android WebView), a real
 * `MarkdownView` editor bound through the production bridge, and — for the wiring scenario — the
 * plugin's own coordinator and `file-open` handler.
 *
 * Two groups, deliberately separated:
 *
 * - **protocol + real editor** — a self-contained coordinator over a path the sync filter ignores, so
 *   the cold path cannot interfere and the result is deterministic. Always runnable.
 * - **plugin wiring** — only with hot sync enabled: it opens a *syncable* scratch note in a leaf and
 *   checks that the plugin's own `file-open` handler takes the path hot and that the resulting fence
 *   keeps the cold scheduler away from it. Skipped, not failed, when the feature is off.
 */

/**
 * The local root the protocol group uses.
 *
 * It lives inside the sync filter's ignored `.mineral/` namespace on purpose: the note must not be
 * a cold-sync candidate, because an ordinary upload landing between the room's acquisition and its
 * first checkpoint would turn a passing run into a precondition failure.
 */
export const HOT_SELF_TEST_ROOT = ".mineral/selftest/";

/**
 * The root a device that refuses dot-directories has to use instead.
 *
 * Android's Obsidian writes a hidden file happily and then does not put it in the vault index, so
 * `getFileByPath` returns null and the file can never be opened in a leaf — which is exactly what the
 * *wiring* group needs to do. This root is visible, and it is in the sync filter's built-in integration
 * prefixes, so a harness file still cannot become one of the user's notes. Both halves of the run use
 * the same root here: a local path that differs from the canonical path would break the editor binding,
 * which is the thing under test.
 */
export const HOT_SELF_TEST_FALLBACK_ROOT = "private/mineral-sync-hot-selftest/";

/**
 * The wiring group's root: a *syncable* path, which is the entire point of that group.
 *
 * It is deliberately not in the sync filter's exclusions — the scenario checks that the plugin's own
 * `file-open` handler takes an ordinary sync candidate hot, and a path the plugin ignores would never
 * become a session at all.
 */
export const HOT_WIRING_ROOT = ".mineral-sync-test/";

/**
 * The wiring root on a device that will not index a hidden one.
 *
 * Same reasoning as the protocol group's fallback, with one extra requirement: this root may not be
 * ignored by the sync filter, because the scenario is about a *candidate* path. So it is visible and
 * ordinary — which is why the scenario deletes what it creates, and why a run on such a device briefly
 * has one extra note in flight.
 */
export const HOT_WIRING_FALLBACK_ROOT = "mineral-sync-hot-wiring/";

/**
 * Which root this device can actually run in.
 *
 * The probe is the same one the cold integration suite learned the hard way: create a file, then ask the
 * vault for it. A device that cannot see it in the index cannot open it in an editor, and there is no
 * point running the editor scenarios to find that out one failure at a time.
 */
export async function selectHotSelfTestRoot(app: App): Promise<{ root: string; wiringRoot: string; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  for (const [label, base, wiringBase] of [
    ["hidden", HOT_SELF_TEST_ROOT, HOT_WIRING_ROOT],
    ["visible", HOT_SELF_TEST_FALLBACK_ROOT, HOT_WIRING_FALLBACK_ROOT],
  ] as const) {
    const probePath = `${base}probe/probe.md`;
    try {
      // Written through the adapter, not the vault API: a hidden path may be writable and not indexed,
      // and `vault.create` refuses one that already exists on disk while `getFileByPath` cannot see it —
      // which would make a second run of this probe fail for a reason that has nothing to do with the
      // device.
      await ensureFolderTree(app.vault, `${base}probe`);
      if (await app.vault.adapter.exists(probePath)) await app.vault.adapter.remove(probePath);
      await app.vault.adapter.write(probePath, "probe\n");
      const visible = app.vault.getFileByPath(probePath) !== null;
      await app.vault.adapter.remove(probePath);
      diagnostics.push(`${label}:create=ok`);
      diagnostics.push(`${label}:indexed=${visible ? "ok" : "FAILED (vault.getFileByPath returned null)"}`);
      if (visible) return { root: base, wiringRoot: wiringBase, diagnostics };
    } catch (error) {
      diagnostics.push(`${label}:create=FAILED (${error instanceof Error ? error.message : "unknown"})`);
    }
  }
  // Nothing worked: the caller still needs a root, and reporting the diagnostics is more useful than
  // throwing before a single scenario has run.
  return { root: HOT_SELF_TEST_FALLBACK_ROOT, wiringRoot: HOT_WIRING_FALLBACK_ROOT, diagnostics };
}

export interface HotSelfTestHost {
  app: App;
  settings: R2SyncSettings;
  /** The plugin's live hot layer, when it has one. Absent means the feature is off or unavailable. */
  hot?: {
    enabled(): boolean;
    coordinator(): HotSyncCoordinator | undefined;
    /**
     * The plugin's own status line, which is the only place that names *why* the hot layer is not running.
     * A device run that cannot open a session is otherwise indistinguishable from one that never tried.
     */
    statusText?(): string;
    refresh(): Promise<void>;
  };
}

export function hotScenarioNames(): string[] {
  return [
    "hot-configuration",
    "hot-open-with-real-editor",
    "hot-local-edit-round-trip",
    "hot-remote-update-reaches-the-editor",
    "hot-handoff-commits-a-baseline",
    "hot-plugin-wiring",
    "hot-cleanup",
  ];
}

export interface HotSelfTestRun {
  results: ScenarioResult[];
  root: string;
  startedAt: number;
  finishedAt: number;
}

const wait = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, everyMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await wait(everyMs);
  }
  return check();
}

/** The real Obsidian transport, wrapped for the hot client's request shape. */
function obsidianTransport(token: string) {
  const transport = new RequestUrlGatewayTransport();
  return (request: HotHttpRequest): Promise<HotHttpResponse> => transport.send({ ...request, token });
}

function obsidianSocket(url: string): HotSocket {
  const socket = new WebSocket(url);
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onMessage: (handler) => socket.addEventListener("message", (event) => handler(String(event.data))),
    onClose: (handler) => socket.addEventListener("close", () => handler()),
  };
}

/** The smallest editor the bridge needs: `getValue()`, `setValue()`, and a ranged `transaction()`. */
class HeadlessEditor {
  transactions = 0;
  constructor(public value = "") {}
  getValue(): string { return this.value; }
  setValue(text: string): void { this.value = text; }
  transaction(tx: { changes?: Array<{ from: { line: number; ch: number }; to: { line: number; ch: number }; text?: string }> }): void {
    this.transactions += 1;
    const changes = [...(tx.changes ?? [])]
      .map(change => ({ from: this.offset(change.from), to: this.offset(change.to), text: change.text ?? "" }))
      .sort((left, right) => right.from - left.from);
    for (const change of changes) this.value = this.value.slice(0, change.from) + change.text + this.value.slice(change.to);
  }
  private offset(position: { line: number; ch: number }): number {
    let offset = 0;
    let line = 0;
    while (line < position.line) {
      const next = this.value.indexOf("\n", offset);
      if (next < 0) return this.value.length;
      offset = next + 1;
      line += 1;
    }
    return Math.min(offset + position.ch, this.value.length);
  }
}

interface HotHarness {
  coordinator: HotSyncCoordinator;
  client: HotGatewayClient;
  baselines: HotBaseline[];
}

function configuration(host: HotSelfTestHost): { endpoint: string; token: string; identity: { endpoint: string; bucket: string; remotePrefix: string } } {
  const settings = host.settings;
  const missing = (["endpoint", "bucket", "accessKeyId", "secretAccessKey"] as const).filter(field => !settings[field]);
  if (missing.length) throw new ScenarioFailure(`hot self-test needs these settings first: ${missing.join(", ")}`);
  if (!settings.gatewayEnabled) throw new ScenarioFailure("hot self-test needs the Sync Gateway enabled: the hot control plane lives there");
  if (!settings.gatewayEndpoint.trim()) throw new ScenarioFailure("hot self-test needs a Gateway endpoint");
  if (!settings.gatewayToken) throw new ScenarioFailure("hot self-test needs a Gateway token");
  return {
    endpoint: settings.gatewayEndpoint.trim(),
    token: settings.gatewayToken,
    identity: { endpoint: settings.endpoint, bucket: settings.bucket, remotePrefix: settings.remotePrefix },
  };
}

async function buildHarness(host: HotSelfTestHost, clientId: string): Promise<HotHarness> {
  const config = configuration(host);
  const channel = await deriveRemoteChangeChannel(config.identity);
  const client = new HotGatewayClient({ endpoint: config.endpoint, token: config.token, channel }, obsidianTransport(config.token), obsidianSocket);
  const baselines: HotBaseline[] = [];
  const coordinator = new HotSyncCoordinator({
    client,
    // A memory store, so a diagnostic run can never leave this device believing it holds a session.
    store: new MemoryHotStateStore(),
    clientId,
    commitBaseline: async (_path, baseline) => { baselines.push(baseline); },
  });
  return { coordinator, client, baselines };
}

async function createNote(app: App, path: string, text: string): Promise<TFile> {
  const slash = path.lastIndexOf("/");
  if (slash > 0) await ensureFolderTree(app.vault, path.slice(0, slash));
  const existing = app.vault.getFileByPath(path);
  if (existing) await app.vault.delete(existing, true);
  return await app.vault.create(path, text);
}

/**
 * Opens a scratch note in a real pane and hands back its editor.
 *
 * Mobile needs more than `openFile`: a leaf created while the app is busy can come back as a deferred
 * view with no editor yet, and only revealing it constructs the real MarkdownView. The fallback search
 * covers the case where the file ends up in a pane other than the one that was requested — which is what
 * a real device reported, with a message that named neither the view type nor the pane.
 */
async function openInEditor(app: App, file: TFile): Promise<{ editor: Editor; close: () => void }> {
  const leaf = app.workspace.getLeaf(true);
  await leaf.openFile(file, { active: true });
  const editorOf = (): Editor | undefined => {
    const direct = (leaf.view as unknown as { editor?: Editor }).editor;
    if (direct) return direct;
    for (const candidate of app.workspace.getLeavesOfType("markdown")) {
      const view = candidate.view as unknown as { editor?: Editor; file?: TFile };
      if (view.file?.path === file.path && view.editor) return view.editor;
    }
    return undefined;
  };
  if (editorOf() === undefined) await app.workspace.revealLeaf(leaf).catch(() => undefined);
  await waitFor(() => editorOf() !== undefined, 10_000);
  const editor = editorOf();
  require(editor, `the opened leaf has no editor; hot sync needs a real MarkdownView (view type: ${(leaf.view as unknown as { getViewType?(): string }).getViewType?.() ?? "unknown"})`);
  return { editor, close: () => leaf.detach() };
}

async function editorValueInPane(app: App, path: string): Promise<string | undefined> {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view as unknown as { editor?: Editor; file?: TFile };
    if (view.file?.path === path && view.editor) return view.editor.getValue();
  }
  return undefined;
}

/**
 * Runs the hot self-test.
 *
 * It never touches a canonical path: the protocol group lives under the ignored `.mineral/`
 * namespace and the wiring group under `.mineral-sync-test/<run>/`, and both halves are removed by the
 * cleanup scenario (a namespace delete for the remote side, a Vault delete for the local one).
 */
export async function runHotSelfTest(host: HotSelfTestHost): Promise<HotSelfTestRun> {
  const startedAt = Date.now();
  const runId = formatRunId(new Date(startedAt));
  // The device decides the root before anything else runs: an index that refuses the hidden namespace
  // would fail every editor scenario for a reason that has nothing to do with hot sync.
  const selected = await selectHotSelfTestRoot(host.app);
  const root = `${selected.root}${runId}/`;
  const notePath = `${root}note.md`;
  const results: ScenarioResult[] = [];
  let primary: HotHarness | null = null;
  let primaryEditor: Editor | null = null;
  let closePrimaryPane: (() => void) | null = null;
  let documentId: string | null = null;
  let documentEpoch = 0;

  const guarded = async (name: string, body: () => Promise<ScenarioObservation[]>): Promise<void> => {
    results.push(await runScenario(name, body));
  };

  await guarded("hot-configuration", async () => {
    const config = configuration(host);
    const channel = await deriveRemoteChangeChannel(config.identity);
    return [
      observation("channel fingerprint", channel.slice(0, 6)),
      observation("hot sync enabled in settings", host.settings.hotSyncEnabled),
      // The plugin's own view of the hot layer, including why it never started. A device run that cannot
      // open a session needs this line more than any other.
      observation("hot status text", host.hot?.statusText?.() ?? "n/a"),
      observation("platform", host.app.vault.configDir ? "desktop-or-mobile" : "unknown"),
      observation("self-test root", root),
      observation("wiring root", selected.wiringRoot),
      ...selected.diagnostics.map(line => observation("root probe", line)),
    ];
  });
  const configured = results.at(-1)?.status === "pass";

  if (!configured) {
    for (const name of hotScenarioNames()) {
      if (results.some(result => result.name === name)) continue;
      results.push({ name, status: "skipped", detail: "hot self-test is not configured; see hot-configuration", observations: [] });
    }
    return { results, root, startedAt, finishedAt: Date.now() };
  }

  await guarded("hot-open-with-real-editor", async () => {
    const created = await createNote(host.app, notePath, "");
    const opened = await openInEditor(host.app, created);
    primaryEditor = opened.editor;
    closePrimaryPane = opened.close;
    primary = await buildHarness(host, `selftest-a-${runId}`);
    const outcome = await primary.coordinator.open({ canonicalPath: notePath, editor: opened.editor, localText: opened.editor.getValue() });
    require(outcome.outcome === "hot", `a free path was not adopted (${outcome.outcome}${outcome.reason ? `: ${outcome.reason}` : ""})`);
    documentId = outcome.identity?.documentId ?? null;
    documentEpoch = outcome.identity?.epoch ?? 0;
    const fence = primary.coordinator.fenceReason(notePath);
    require(fence === "hot", `the opened document is not fenced (${fence})`);
    return [
      observation("document epoch", documentEpoch),
      observation("room state", "active"),
      observation("editor bound", true),
      observation("fence", fence ?? "none"),
    ];
  });

  await guarded("hot-local-edit-round-trip", async () => {
    const active = requirePrimary(primary, notePath);
    const editor = primaryEditor;
    require(editor, "the real editor was not captured");
    const text = `${runId} line one\n`;
    editor.setValue(text);
    await active.coordinator.handleEditorChange(notePath);
    const acknowledged = await waitFor(() => (active.coordinator.sessionFor(notePath)?.session?.lastAcceptedRevision ?? 0) >= 1, 15_000);
    require(acknowledged, "the server never acknowledged the local edit");
    const receipt = await active.coordinator.sessionFor(notePath)!.requestCheckpoint(1);
    require(receipt, "no checkpoint covering the acknowledged revision arrived");
    require(receipt.contentHash === await hotContentHash(active.coordinator.bindingFor(notePath)?.text() ?? ""), "the checkpoint does not describe the local bytes");
    require(Boolean(receipt.r2ETag), "the checkpoint did not report an R2 revision");
    const inPane = await editorValueInPane(host.app, notePath);
    require(inPane === text, `the pane and the editor disagree (${JSON.stringify(inPane ?? null)})`);
    return [
      observation("accepted revision", receipt.documentRevision),
      observation("content hash matches the local bytes", true),
      observation("r2 revision reported", true),
    ];
  });

  await guarded("hot-remote-update-reaches-the-editor", async () => {
    const active = requirePrimary(primary, notePath);
    const second = await buildHarness(host, `selftest-b-${runId}`);
    // A second device arrives with the file it already has — which is what a real one does, having synced
    // it. Opening with empty content instead is a *different* case the room refuses on purpose
    // (`local-remote-mismatch`): a device may not push its own idea of the document over one it has not
    // read. The device run is what surfaced how easily a scenario can conflate the two.
    const known = active.coordinator.bindingFor(notePath)?.text() ?? "";
    const headless = new HeadlessEditor(known);
    const join = await second.coordinator.open({ canonicalPath: notePath, editor: headless as unknown as Editor, localText: headless.getValue() });
    require(join.outcome === "hot", `the second device could not join (${join.outcome}${join.reason ? `: ${join.reason}` : ""})`);
    // The second device types; the real editor must receive it through the production bridge.
    headless.setValue(`${headless.getValue()}from the second device\n`);
    await second.coordinator.handleEditorChange(notePath);
    const binding = active.coordinator.bindingFor(notePath);
    require(binding, "the editor binding is missing for the open document");
    const received = await waitFor(() => binding.text().includes("from the second device"), 15_000, 200);
    require(received, "the real editor never received the remote update");
    const inPane = await editorValueInPane(host.app, notePath);
    require(inPane === binding.text(), "the editor pane and the CRDT disagree after a remote update");
    const closed = await second.coordinator.close({ canonicalPath: notePath, localText: headless.getValue() });
    require(closed.outcome === "saved-hot-elsewhere", `the second device's handoff was ${closed.outcome}${closed.detail ? `: ${closed.detail}` : ""}`);
    return [
      observation("remote update applied to the real editor", true),
      observation("editor pane equals CRDT", true),
      observation("second device outcome", closed.outcome),
    ];
  });

  await guarded("hot-handoff-commits-a-baseline", async () => {
    const active = requirePrimary(primary, notePath);
    const localText = active.coordinator.bindingFor(notePath)?.text() ?? "";
    const outcome = await active.coordinator.close({ canonicalPath: notePath, localText });
    require(outcome.outcome === "handed-off", `the handoff did not complete (${outcome.outcome}${outcome.detail ? `: ${outcome.detail}` : ""})`);
    require(outcome.receipt?.contentHash === await hotContentHash(localText), "the receipt does not cover the local bytes");
    require(active.baselines.length === 1, `the cold baseline was not committed (${active.baselines.length})`);
    require(active.coordinator.fenceReason(notePath) === null, "the path is still fenced after a completed handoff");
    return [
      observation("handoff outcome", outcome.outcome),
      observation("baseline revision", active.baselines[0].documentRevision),
      observation("baseline has an r2 revision", Boolean(active.baselines[0].r2ETag)),
      observation("fence released", true),
    ];
  });

  await guarded("hot-plugin-wiring", async () => {
    const live = host.hot;
    if (!live?.enabled()) return [observation("result", "skipped: hot sync is disabled in settings; enable it to test the plugin's own wiring")];
    await live.refresh();
    const coordinator = live.coordinator();
    require(coordinator, "hot sync is enabled but the coordinator is not running");
    const wiringPath = `${selected.wiringRoot}${runId}/hot/wiring.md`;
    const created = await createNote(host.app, wiringPath, `${runId} wiring\n`);
    const opened = await openInEditor(host.app, created);
    try {
      // Nothing here calls open(): the plugin's own `file-open` handler is what must take it hot.
      const hot = await waitFor(() => coordinator.statusOf(wiringPath).status === "hot", 20_000, 250);
      require(hot, `the plugin did not open a hot session for the scratch note (${coordinator.statusOf(wiringPath).status})`);
      require(coordinator.fenceReason(wiringPath) === "hot", "the path is hot but not fenced");
      const session = coordinator.sessionFor(wiringPath);
      const accepted = await waitFor(() => (session?.session?.lastAcceptedRevision ?? 0) >= 1, 20_000, 250);
      // The numbers go into the failure message on purpose: a device run cannot be instrumented after
      // the fact, so a failing scenario has to carry enough to explain itself.
      require(accepted, `the plugin's own edit never reached the server (status=${coordinator.statusOf(wiringPath).status}/${coordinator.statusOf(wiringPath).reason ?? "n/a"}, binding=${coordinator.bindingFor(wiringPath)?.text().length ?? -1}, editor=${(await editorValueInPane(host.app, wiringPath))?.length ?? -1}, revision=${session?.session?.lastAcceptedRevision ?? -1}, outbox=${session?.pending().length ?? -1}, pendingSave=${session?.session?.pendingSave ?? "?"})`);
      const localText = coordinator.bindingFor(wiringPath)?.text() ?? "";
      const closed = await coordinator.close({ canonicalPath: wiringPath, localText });
      require(closed.outcome === "handed-off", `the plugin's handoff did not complete (${closed.outcome}${closed.detail ? `: ${closed.detail}` : ""})`);
      return [observation("plugin opened the session", true), observation("plugin handoff outcome", closed.outcome)];
    } finally {
      opened.close();
      const file = host.app.vault.getFileByPath(wiringPath);
      if (file) await host.app.vault.delete(file, true).catch(() => undefined);
    }
  });

  await guarded("hot-cleanup", async () => {
    const active = primary;
    if (active && documentId) {
      // The remote half is a logical deletion through the same namespace operation the product uses.
      const deletion = await active.client.namespace({
        type: "delete",
        operationId: `selftest-cleanup-${runId}`,
        clientId: `selftest-a-${runId}`,
        canonicalPath: notePath,
        documentId,
        expectedEpoch: documentEpoch,
        expectedRemoteETag: null,
        expectedDocumentRevision: null,
      });
      require(["applied", "conflict"].includes(deletion.outcome), `the cleanup delete was ${deletion.outcome}${deletion.reason ? `: ${deletion.reason}` : ""}`);
    }
    closePrimaryPane?.();
    const file = host.app.vault.getFileByPath(notePath);
    if (file) await host.app.vault.delete(file, true).catch(() => undefined);
    const gone = host.app.vault.getFileByPath(notePath) === null;
    require(gone, "the local scratch note could not be removed");
    return [observation("local scratch removed", true), observation("remote path retired", Boolean(documentId))];
  });

  return { results, root, startedAt, finishedAt: Date.now() };
}

function requirePrimary(harness: HotHarness | null, path: string): HotHarness {
  require(harness, "the primary hot harness was never created");
  require(harness.coordinator.bindingFor(path) ?? harness.coordinator.sessionFor(path), "the primary session is gone");
  return harness;
}




