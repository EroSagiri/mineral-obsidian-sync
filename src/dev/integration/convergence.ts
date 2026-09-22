import type { Vault } from "obsidian";
import type { R2Client } from "../../remote/r2-client";
import type { StateStore } from "../../state/sync-state";
import { SafeExecutor } from "../../sync/executor";
import type { OperationResult } from "../../sync/executor";
import { canonicalKey } from "../../sync/path";
import { buildSyncPlan } from "../../sync/planner";
import type { LocalEntry, PreviousEntry, RemoteEntry, RemoteIdentity, SyncOperation, SyncPlan } from "../../sync/types";
import { sameBytes, utf8 } from "./bytes";
import { ensureFolder, ensureFolderTree } from "./local-scratch";
import type { LocalScratch } from "./local-scratch";
import { observation, require, runScenario, ScenarioFailure, skipScenario } from "./result";
import type { ScenarioObservation, ScenarioResult } from "./result";

/**
 * Executor-level scenarios. SafeExecutor, the planner and the state store under test are the
 * real product implementations; only the R2 endpoint and (in unit runs) the Vault are stand-ins.
 *
 * Every local file lives under the resolved scratch root, so a personal Vault file can never
 * enter the observed fact map and can never be touched by the executor.
 */

export interface ConvergenceContext {
  vault: Vault;
  /** Already scoped: it refuses any key outside the scratch root, and any key whose object key escapes the run prefix. */
  client: R2Client;
  state: StateStore;
  /** Resolved local root; see `local-scratch.ts`. */
  scratch: LocalScratch;
  identity: RemoteIdentity;
  ignorePolicy: string;
  /** Fault-injected client whose first delivered PUT loses its response. */
  ambiguousClient?: R2Client;
}

export interface StepOutcome {
  type: SyncOperation["type"];
  key: string;
  status: OperationResult["status"] | "not-executed";
  reason?: string;
}

/** Read-only local scan limited to the scratch root. */
export function scanLocalNamespace(vault: Vault, root: string): Map<string, LocalEntry> {
  const entries = new Map<string, LocalEntry>();
  for (const file of vault.getFiles()) {
    const key = canonicalKey(file.path);
    if (!key.startsWith(root)) continue;
    entries.set(key, { key, size: file.stat.size, mtime: file.stat.mtime });
  }
  return entries;
}

/** Baselines from outside the scratch root must never influence an integration plan. */
export function scopedPrevious(previous: Map<string, PreviousEntry>, root: string): Map<string, PreviousEntry> {
  return new Map([...previous].filter(([key]) => key.startsWith(root)));
}

export interface NamespaceObservation {
  local: Map<string, LocalEntry>;
  remote: Map<string, RemoteEntry>;
  previous: Map<string, PreviousEntry>;
  plan: SyncPlan;
}

/**
 * Local scan + one scoped remote `ListObjectsV2` + previous state, then the deterministic planner.
 *
 * The remote scan uses LIST rather than a per-key HEAD for two reasons: it is the same primitive
 * the product's own remote scan uses, and a HEAD that returns 404 throws at the transport layer on
 * Obsidian for Android (measured 2026-09-21), which would have made this whole harness unusable
 * there. One scoped LIST also replaces N conditional HEADs.
 */
export async function observe(context: ConvergenceContext, extraKeys: readonly string[] = []): Promise<NamespaceObservation> {
  const local = scanLocalNamespace(context.vault, context.scratch.root);
  const wanted = new Set<string>([...local.keys(), ...extraKeys]);
  const remote = new Map((await context.client.listObjects()).filter((entry) => wanted.has(entry.key)).map((entry) => [entry.key, entry]));
  const previous = scopedPrevious(await context.state.loadAll(), context.scratch.root);
  return { local, remote, previous, plan: buildSyncPlan(local, remote, previous) };
}

/** Ground truth for a single key, using the same LIST primitive. */
async function remoteExists(client: R2Client, key: string): Promise<boolean> {
  return (await client.listObjects()).some((entry) => entry.key === key);
}

export function planSummary(plan: SyncPlan): string {
  if (!plan.operations.length) return "empty";
  const counts = new Map<string, number>();
  for (const operation of plan.operations) counts.set(operation.type, (counts.get(operation.type) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => `${type}:${count}`).join(" ");
}

export function outcomeSummary(outcomes: readonly StepOutcome[]): string {
  if (!outcomes.length) return "empty";
  const counts = new Map<string, number>();
  for (const outcome of outcomes) counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => `${status}:${count}`).join(" ");
}

function typeCount(plan: SyncPlan, type: SyncOperation["type"]): number {
  return plan.operations.filter((operation) => operation.type === type).length;
}

/** Requires exactly one operation of the stated type for the key, and narrows its shape. */
function requireOperation<T extends SyncOperation["type"]>(plan: SyncPlan, key: string, type: T): Extract<SyncOperation, { type: T }> {
  const operations = plan.operations.filter((operation) => operation.key === key);
  if (operations.length !== 1 || operations[0]!.type !== type) {
    throw new ScenarioFailure(`expected exactly one ${type} operation for the scenario key; plan was ${planSummary(plan)}`);
  }
  return operations[0] as Extract<SyncOperation, { type: T }>;
}

function requireOutcome(outcomes: readonly StepOutcome[], key: string): StepOutcome {
  const outcome = outcomes.find((entry) => entry.key === key);
  if (!outcome) throw new ScenarioFailure("no execution outcome was recorded for the scenario key");
  return outcome;
}

/** Sequential execution of an already-observed plan; noop/conflict are never handed to the executor. */
export async function executePlan(context: ConvergenceContext, plan: SyncPlan, client: R2Client = context.client): Promise<StepOutcome[]> {
  const executor = new SafeExecutor(context.vault, client, context.state, context.identity, context.ignorePolicy);
  const outcomes: StepOutcome[] = [];
  for (const operation of plan.operations) {
    if (operation.type === "noop" || operation.type === "conflict") {
      outcomes.push({ type: operation.type, key: operation.key, status: "not-executed" });
      continue;
    }
    const result = await executor.execute(operation);
    outcomes.push({ type: operation.type, key: operation.key, status: result.status, reason: "reason" in result ? result.reason : undefined });
  }
  return outcomes;
}

/** Test-only fault injection: the PUT reaches R2, but the response is reported as lost. */
export function lostResponseClient(inner: R2Client, failOnCall = 1): R2Client {
  let delivered = 0;
  return {
    listObjects: () => inner.listObjects(),
    headObject: (key, options) => inner.headObject(key, options),
    getObject: (key, options) => inner.getObject(key, options),
    putObject: async (key, body, options) => {
      const entry = await inner.putObject(key, body, options);
      delivered += 1;
      if (delivered >= failOnCall) throw new Error("Simulated lost PUT response (integration fault injection)");
      return entry;
    },
  };
}

/** Fails only the per-key state commit, leaving the real store untouched. */
class FailingStateStore implements StateStore {
  constructor(private readonly inner: StateStore) {}
  loadAll(): Promise<Map<string, PreviousEntry>> {
    return this.inner.loadAll();
  }
  saveVerified(entries: Map<string, PreviousEntry>): Promise<void> {
    return this.inner.saveVerified(entries);
  }
  saveAll(entries: Map<string, PreviousEntry>): Promise<void> {
    return this.inner.saveAll(entries);
  }
  async put(): Promise<void> {
    throw new Error("Simulated IndexedDB commit failure (integration fault injection)");
  }
  async delete(): Promise<void> {
    throw new Error("Simulated IndexedDB commit failure (integration fault injection)");
  }
}

export function convergenceScenarioNames(): string[] {
  return ["safe-executor-convergence", "download-applied", "download-blocked-by-file-parent", "stale-remote-preserved", "remote-advanced-after-write", "stale-local-preserved", "state-commit-failure", "ambiguous-put"];
}

export async function runConvergenceScenarios(context: ConvergenceContext): Promise<ScenarioResult[]> {
  const ambiguous = context.ambiguousClient;
  return [
    await runScenario("safe-executor-convergence", () => convergenceScenario(context)),
    await runScenario("download-applied", () => downloadAppliedScenario(context)),
    await runScenario("download-blocked-by-file-parent", () => downloadParentFileScenario(context)),
    await runScenario("stale-remote-preserved", () => staleRemoteScenario(context)),
    await runScenario("remote-advanced-after-write", () => remoteAdvancedScenario(context)),
    await runScenario("stale-local-preserved", () => staleLocalScenario(context)),
    await runScenario("state-commit-failure", () => stateCommitFailureScenario(context)),
    ambiguous ? await runScenario("ambiguous-put", () => ambiguousPutScenario(context, ambiguous)) : skipScenario("ambiguous-put", "no fault-injected client was supplied"),
  ];
}

/** Refuses to write over anything that already exists at the scratch key. */
function requireLocalAbsent(context: ConvergenceContext, key: string): void {
  require(context.vault.getFileByPath(key) === null, `refusing to create a scratch file: a local Vault file already exists at that run-scoped path`);
}

/** Phase 12: first reconciliation uploads, commits a baseline, and the next plan is a noop. */
async function convergenceScenario(context: ConvergenceContext): Promise<ScenarioObservation[]> {
  const key = context.scratch.key("test-file.md");
  const body = utf8("mineral sync convergence v1");
  requireLocalAbsent(context, key);
  await context.vault.createBinary(key, body);

  const first = await observe(context, [key]);
  require(!first.previous.has(key), "the integration state store already held a baseline for this run root");
  requireOperation(first.plan, key, "upload");
  // This scenario runs on a fresh run root, so it executes the complete observed plan.
  require(first.plan.operations.every((operation) => operation.key === key), `the first plan mentioned unrelated keys: ${planSummary(first.plan)}`);
  require(typeCount(first.plan, "upload") === 1, `first plan was ${planSummary(first.plan)}`);

  const firstOutcomes = await executePlan(context, first.plan);
  require(requireOutcome(firstOutcomes, key).status === "applied", `first execution was ${outcomeSummary(firstOutcomes)}`);

  const committed = scopedPrevious(await context.state.loadAll(), context.scratch.root).get(key);
  require(committed, "the upload committed no previous-state entry");
  require(committed.remote?.etag, "the committed entry carried no remote ETag");
  require(committed.local?.size === body.byteLength, "the committed local baseline did not match the uploaded content");

  const second = await observe(context, [key]);
  requireOperation(second.plan, key, "noop");

  return [
    observation("local scratch root", context.scratch.root),
    observation("first plan", planSummary(first.plan)),
    observation("first execution", outcomeSummary(firstOutcomes)),
    observation("previous-state commit", "1 entry"),
    observation("second plan", planSummary(second.plan)),
  ];
}

/**
 * Phase 12b: a successful download must create the missing parent folders itself.
 * `Vault.createBinary` does not mkdir parents (verified on a real Vault), so this scenario is the
 * happy path that would otherwise never be exercised: remote-only file, no local folder.
 */
async function downloadAppliedScenario(context: ConvergenceContext): Promise<ScenarioObservation[]> {
  const cases: Array<{ leaf: string; preCreatedParent: string[] }> = [
    // 1. remote-only file directly in the existing scratch root: no folder is needed at all.
    { leaf: "root-file.md", preCreatedParent: [] },
    // 2. one missing level.
    { leaf: "one-level/foo.md", preCreatedParent: [] },
    // 3. a fully missing chain.
    { leaf: "multi/level/deep/foo.md", preCreatedParent: [] },
    // 4. the parent already exists.
    { leaf: "existing/parent/kept.md", preCreatedParent: ["existing/parent"] },
  ];
  let parentFoldersCreated = false;

  for (const item of cases) {
    const key = context.scratch.key(item.leaf);
    requireLocalAbsent(context, key);
    for (const folder of item.preCreatedParent) await ensureFolderTree(context.vault, context.scratch.key(folder));
    const parentPath = key.slice(0, key.lastIndexOf("/"));
    const parentExistedBefore = context.vault.getAbstractFileByPath(parentPath) !== null;

    const body = utf8(`remote payload for ${item.leaf}`);
    await context.client.putObject(key, body, { ifNoneMatch: "*" });
    const planned = requireOperation((await observe(context, [key])).plan, key, "download");

    const outcome = requireOutcome(await executePlan(context, { operations: [planned] }), key);
    require(outcome.status === "applied", `downloading ${item.leaf} returned ${outcome.status}${outcome.reason ? `/${outcome.reason}` : ""}`);

    const file = context.vault.getFileByPath(key);
    if (!file) throw new ScenarioFailure(`the download created no local file for ${item.leaf}`);
    require(sameBytes(await context.vault.readBinary(file), body), `the downloaded bytes differ for ${item.leaf}`);
    require(scopedPrevious(await context.state.loadAll(), context.scratch.root).get(key)?.remote?.etag, `no committed baseline after downloading ${item.leaf}`);
    if (!parentExistedBefore && context.vault.getAbstractFileByPath(parentPath) !== null) parentFoldersCreated = true;
  }

  const nestedKey = context.scratch.key("multi/level/deep/foo.md");
  requireOperation((await observe(context, [nestedKey])).plan, nestedKey, "noop");

  return [
    observation("remote-only nested file", "multi/level/deep/foo.md"),
    observation("missing parent folders created", parentFoldersCreated),
    observation("local bytes exact", true),
    observation("previous state committed", true),
    observation("second reconciliation", "noop"),
  ];
}

/** Phase 12c: a file occupying a parent path is a definite failure, never an overwrite. */
async function downloadParentFileScenario(context: ConvergenceContext): Promise<ScenarioObservation[]> {
  const occupier = context.scratch.key("blocked/occupier");
  await ensureFolder(context.vault, context.scratch.key("blocked"));
  const occupierBody = utf8("local file occupying the parent path");
  await context.vault.createBinary(occupier, occupierBody);

  const target = context.scratch.key("blocked/occupier/child.md");
  await context.client.putObject(target, utf8("remote payload under a file parent"), { ifNoneMatch: "*" });

  const planned = requireOperation((await observe(context, [target])).plan, target, "download");
  const outcome = requireOutcome(await executePlan(context, { operations: [planned] }), target);
  require(outcome.status === "failed", `a download under a file parent returned ${outcome.status}`);
  require(outcome.reason === "parent-path-is-file", `the blocked download was classified as ${outcome.reason}`);

  const occupierFile = context.vault.getFileByPath(occupier);
  if (!occupierFile) throw new ScenarioFailure("the local file occupying the parent path disappeared");
  require(sameBytes(await context.vault.readBinary(occupierFile), occupierBody), "the blocked download modified the file occupying the parent path");
  require(!context.vault.getFiles().some((file) => file.path === target), "the blocked download still created a file under a file parent");
  require(!scopedPrevious(await context.state.loadAll(), context.scratch.root).has(target), "previous state was mutated by a blocked download");

  return [
    observation("parent path occupied by a file", "blocked/occupier"),
    observation("execution", `${outcome.status}/${outcome.reason}`),
    observation("occupying file preserved", true),
    observation("previous state mutated", false),
  ];
}

/** Phase 13: a remote change after planning is stale, and the newer remote body survives. */
async function staleRemoteScenario(context: ConvergenceContext): Promise<ScenarioObservation[]> {
  const key = context.scratch.key("stale-remote.md");
  requireLocalAbsent(context, key);
  await context.vault.createBinary(key, utf8("stale remote v1"));

  const first = await observe(context, [key]);
  const establishing = requireOperation(first.plan, key, "upload");
  // Only this scenario's own operation is executed, so leftovers from other scenarios cannot leak in.
  require(requireOutcome(await executePlan(context, { operations: [establishing] }), key).status === "applied", "the establishing upload did not apply");

  const baseline = scopedPrevious(await context.state.loadAll(), context.scratch.root).get(key);
  const etagA = baseline?.remote?.etag;
  require(etagA, "the establishing upload produced no committed ETag");

  const localFile = context.vault.getFileByPath(key);
  if (!localFile) throw new ScenarioFailure("the local scratch file disappeared before the local edit");
  await context.vault.modifyBinary(localFile, utf8("stale remote v2 local edit"));

  // The plan is taken after the local edit and *before* the external write, so the external
  // write is exactly the "remote moved after planning" case.
  const stale = requireOperation((await observe(context, [key])).plan, key, "upload");
  require(stale.expectedRemote.kind === "etag" && stale.expectedRemote.value === etagA, "the update did not carry the observed ETag precondition");

  const external = utf8("external newer content v3");
  const etagB = (await context.client.putObject(key, external, { ifMatch: etagA })).etag;
  require(etagB && etagB !== etagA, "the external write did not advance the remote ETag");

  const upload = requireOutcome(await executePlan(context, { operations: [stale] }), key);
  require(upload.status === "stale", `the stale upload returned ${upload.status} instead of stale`);
  require(upload.reason === "remote-changed", `the stale upload was classified as ${upload.reason}`);

  const unchanged = scopedPrevious(await context.state.loadAll(), context.scratch.root).get(key);
  require(unchanged?.remote?.etag === etagA, "previous state was mutated by a stale remote precondition failure");
  require(sameBytes(await context.client.getObject(key), external), "the stale upload overwrote newer remote content");

  return [
    observation("plan before the external write", "upload"),
    observation("execution", `${upload.status}/${upload.reason}`),
    observation("previous state mutated", false),
    observation("newer remote body preserved", true),
  ];
}

/**
 * Phase 13c: a baseline recorded from a PUT stays valid when the remote advances afterwards.
 *
 * This is the scenario that justifies dropping the post-PUT confirmation HEAD. The baseline records
 * "local L became remote B" — a fact settled the moment the PUT returned. If another device then
 * moves the object to C, that is *not* a failure of our write, and the three-way planner must
 * express it as an ordinary remote-only change.
 */
async function remoteAdvancedScenario(context: ConvergenceContext): Promise<ScenarioObservation[]> {
  const key = context.scratch.key("remote-advanced.md");
  requireLocalAbsent(context, key);
  await context.vault.createBinary(key, utf8("remote advanced v1"));

  const planned = requireOperation((await observe(context, [key])).plan, key, "upload");
  const applied = requireOutcome(await executePlan(context, { operations: [planned] }), key);
  require(applied.status === "applied", `the establishing upload returned ${applied.status}`);

  const committed = scopedPrevious(await context.state.loadAll(), context.scratch.root).get(key)?.remote;
  require(committed, "the upload committed no remote baseline");
  const etagB = committed.etag;
  require(etagB, "the committed baseline carries no ETag");
  // The ETag comes from the PUT response; the server timestamp is knowingly unknown, not invented.
  require(committed.lastModified === undefined, "the committed baseline fabricated a server timestamp");

  const advanced = utf8("remote advanced v2 from another device");
  const etagC = (await context.client.putObject(key, advanced, { ifMatch: etagB })).etag;
  require(etagC && etagC !== etagB, "the external write did not advance the ETag");

  // The next reconcile must see a remote-only change, not a stuck or confused state.
  const followUp = requireOperation((await observe(context, [key])).plan, key, "download");
  require(followUp.expectedRemote.etag === etagC, `the plan expected ${followUp.expectedRemote.etag} instead of the observed ${etagC}`);
  require(requireOutcome(await executePlan(context, { operations: [followUp] }), key).status === "applied", "the follow-up download did not apply");

  const file = context.vault.getFileByPath(key);
  if (!file) throw new ScenarioFailure("the follow-up download created no local file");
  require(sameBytes(await context.vault.readBinary(file), advanced), "the follow-up download did not converge to the newer remote content");
  requireOperation((await observe(context, [key])).plan, key, "noop");

  return [
    observation("baseline ETag source", "the PUT response (no confirmation HEAD)"),
    observation("committed lastModified", "unknown — not fabricated"),
    observation("external advance", `${etagB.slice(0, 8)}… → ${etagC.slice(0, 8)}…`),
    observation("next plan", "download (remote-only change)"),
    observation("converged", "noop"),
  ];
}

/** Phase 14: a local change after planning is stale, and the newer local content survives. */
async function staleLocalScenario(context: ConvergenceContext): Promise<ScenarioObservation[]> {
  const key = context.scratch.key("stale-local.md");
  requireLocalAbsent(context, key);

  const remoteBody = utf8("remote-only content v1");
  await context.client.putObject(key, remoteBody, { ifNoneMatch: "*" });

  const planned = requireOperation((await observe(context, [key])).plan, key, "download");
  require("kind" in planned.expectedLocal, "the download did not require an absent local target");

  const localBody = utf8("local content created after the plan");
  await context.vault.createBinary(key, localBody);

  const download = requireOutcome(await executePlan(context, { operations: [planned] }), key);
  require(download.status === "stale", `the stale download returned ${download.status} instead of stale`);
  require(download.reason === "local-changed", `the stale download was classified as ${download.reason}`);

  const localFile = context.vault.getFileByPath(key);
  if (!localFile) throw new ScenarioFailure("the local scratch file vanished during the stale download");
  require(sameBytes(await context.vault.readBinary(localFile), localBody), "the download overwrote newer local content");
  require(!scopedPrevious(await context.state.loadAll(), context.scratch.root).has(key), "previous state was mutated by a stale local precondition failure");

  return [
    observation("plan", "download into an absent local target"),
    observation("execution", `${download.status}/${download.reason}`),
    observation("newer local body preserved", true),
    observation("previous state mutated", false),
  ];
}

/** Phase 16: a successful R2 write with a failed state commit is unresolved and not rolled back. */
async function stateCommitFailureScenario(context: ConvergenceContext): Promise<ScenarioObservation[]> {
  const key = context.scratch.key("state-failure.md");
  const body = utf8("state failure payload v1");
  requireLocalAbsent(context, key);
  await context.vault.createBinary(key, body);

  const planned = requireOperation((await observe(context, [key])).plan, key, "upload");

  const failing: ConvergenceContext = { ...context, state: new FailingStateStore(context.state) };
  const upload = requireOutcome(await executePlan(failing, { operations: [planned] }), key);
  require(upload.status === "unresolved", `a failed state commit returned ${upload.status} instead of unresolved`);
  require(upload.reason === "state-commit-failed", `the unresolved upload was classified as ${upload.reason}`);
  require(sameBytes(await context.client.getObject(key), body), "the successful R2 write was rolled back after the state commit failed");
  require(!scopedPrevious(await context.state.loadAll(), context.scratch.root).has(key), "a failed state commit still produced a committed baseline");

  return [
    observation("execution", `${upload.status}/${upload.reason}`),
    observation("R2 write preserved", true),
    observation("previous state committed", false),
  ];
}

/** Phase 15: a PUT whose outcome is unknown must not commit previous state. */
async function ambiguousPutScenario(context: ConvergenceContext, client: R2Client): Promise<ScenarioObservation[]> {
  const key = context.scratch.key("ambiguous.md");
  const body = utf8("ambiguous put payload v1");
  requireLocalAbsent(context, key);
  await context.vault.createBinary(key, body);

  const planned = requireOperation((await observe(context, [key])).plan, key, "upload");

  const upload = requireOutcome(await executePlan(context, { operations: [planned] }, client), key);
  require(upload.status === "unresolved", `an ambiguous PUT returned ${upload.status} instead of unresolved`);
  require(upload.reason === "ambiguous-put", `the ambiguous PUT was classified as ${upload.reason}`);
  require(!scopedPrevious(await context.state.loadAll(), context.scratch.root).has(key), "an ambiguous PUT committed previous state");

  const landed = await remoteExists(context.client, key);
  require(landed, "the injected fault did not actually deliver the PUT to R2");
  require(sameBytes(await context.client.getObject(key), body), "the delivered PUT stored unexpected bytes");

  return [
    observation("execution", `${upload.status}/${upload.reason}`),
    observation("previous state committed", false),
    observation("remote object present", true),
  ];
}
