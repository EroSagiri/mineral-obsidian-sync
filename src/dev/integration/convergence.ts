import type { Vault } from "obsidian";
import type { R2Client } from "../../remote/r2-client";
import type { StateStore } from "../../state/sync-state";
import { SafeExecutor } from "../../sync/executor";
import type { OperationResult } from "../../sync/executor";
import { canonicalKey } from "../../sync/path";
import { buildSyncPlan } from "../../sync/planner";
import type { LocalEntry, PreviousEntry, RemoteEntry, RemoteIdentity, SyncOperation, SyncPlan } from "../../sync/types";
import { sameBytes, utf8 } from "./bytes";
import { headOrAbsent } from "./guarded-client";
import type { IntegrationTestNamespace } from "./test-namespace";
import { observation, require, runScenario, ScenarioFailure, skipScenario } from "./result";
import type { ScenarioObservation, ScenarioResult } from "./result";

/**
 * Executor-level scenarios. SafeExecutor, the planner and the state store under test are the
 * real product implementations; only the R2 endpoint and (in unit runs) the Vault are stand-ins.
 *
 * The local scan is deliberately restricted to the run namespace, so a personal Vault file can
 * never enter the observed fact map and can never be touched by the executor.
 */

export interface ConvergenceContext {
  vault: Vault;
  /** Already prefix-guarded. */
  client: R2Client;
  state: StateStore;
  namespace: IntegrationTestNamespace;
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

/** Read-only local scan limited to the integration namespace. */
export function scanLocalNamespace(vault: Vault, root: string): Map<string, LocalEntry> {
  const entries = new Map<string, LocalEntry>();
  for (const file of vault.getFiles()) {
    const key = canonicalKey(file.path);
    if (!key.startsWith(root)) continue;
    entries.set(key, { key, size: file.stat.size, mtime: file.stat.mtime });
  }
  return entries;
}

/** Baselines from other namespaces must never influence an integration plan. */
export function namespacePrevious(previous: Map<string, PreviousEntry>, namespace: IntegrationTestNamespace): Map<string, PreviousEntry> {
  return new Map([...previous].filter(([key]) => namespace.isOwned(key)));
}

export interface NamespaceObservation {
  local: Map<string, LocalEntry>;
  remote: Map<string, RemoteEntry>;
  previous: Map<string, PreviousEntry>;
  plan: SyncPlan;
}

/** Local scan + per-key remote HEAD + previous state, then the deterministic planner. */
export async function observe(context: ConvergenceContext, extraKeys: readonly string[] = []): Promise<NamespaceObservation> {
  const local = scanLocalNamespace(context.vault, context.namespace.root);
  const keys = [...new Set([...local.keys(), ...extraKeys])].sort((a, b) => a.localeCompare(b));
  const remote = new Map<string, RemoteEntry>();
  for (const key of keys) {
    const entry = await headOrAbsent(context.client, key);
    if (entry) remote.set(key, entry);
  }
  const previous = namespacePrevious(await context.state.loadAll(), context.namespace);
  return { local, remote, previous, plan: buildSyncPlan(local, remote, previous) };
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
    throw new ScenarioFailure(`expected exactly one ${type} operation for ${key}; plan was ${planSummary(plan)}`);
  }
  return operations[0] as Extract<SyncOperation, { type: T }>;
}

function requireOutcome(outcomes: readonly StepOutcome[], key: string): StepOutcome {
  const outcome = outcomes.find((entry) => entry.key === key);
  if (!outcome) throw new ScenarioFailure(`no execution outcome was recorded for ${key}`);
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
}

export function convergenceScenarioNames(): string[] {
  return ["safe-executor-convergence", "stale-remote-preserved", "stale-local-preserved", "state-commit-failure", "ambiguous-put"];
}

export async function runConvergenceScenarios(context: ConvergenceContext): Promise<ScenarioResult[]> {
  const ambiguous = context.ambiguousClient;
  return [
    await runScenario("safe-executor-convergence", () => convergenceScenario(context)),
    await runScenario("stale-remote-preserved", () => staleRemoteScenario(context)),
    await runScenario("stale-local-preserved", () => staleLocalScenario(context)),
    await runScenario("state-commit-failure", () => stateCommitFailureScenario(context)),
    ambiguous ? await runScenario("ambiguous-put", () => ambiguousPutScenario(context, ambiguous)) : skipScenario("ambiguous-put", "no fault-injected client was supplied"),
  ];
}

/** Refuses to write over anything that already exists at the test key. */
function requireLocalAbsent(context: ConvergenceContext, key: string): void {
  require(context.vault.getFileByPath(key) === null, `refusing to create ${key}: a local Vault file already exists there`);
}

/** Phase 12: first reconciliation uploads, commits a baseline, and the next plan is a noop. */
async function convergenceScenario(context: ConvergenceContext): Promise<ScenarioObservation[]> {
  const key = context.namespace.key("convergence/test-file.md");
  const body = utf8("mineral sync convergence v1");
  requireLocalAbsent(context, key);
  await context.vault.createBinary(key, body);

  const first = await observe(context, [key]);
  require(!first.previous.has(key), "the integration state store already held a baseline for this run root");
  requireOperation(first.plan, key, "upload");
  require(typeCount(first.plan, "upload") === 1, `first plan was ${planSummary(first.plan)}`);

  const firstOutcomes = await executePlan(context, first.plan);
  require(requireOutcome(firstOutcomes, key).status === "applied", `first execution was ${outcomeSummary(firstOutcomes)}`);

  const committed = namespacePrevious(await context.state.loadAll(), context.namespace).get(key);
  require(committed, "the upload committed no previous-state entry");
  require(committed.remote?.etag, "the committed entry carried no remote ETag");
  require(committed.local?.size === body.byteLength, "the committed local baseline did not match the uploaded content");

  const second = await observe(context, [key]);
  requireOperation(second.plan, key, "noop");

  return [
    observation("first plan", planSummary(first.plan)),
    observation("first execution", outcomeSummary(firstOutcomes)),
    observation("previous-state commit", "1 entry"),
    observation("second plan", planSummary(second.plan)),
  ];
}

/** Phase 13: a remote change after planning is stale, and the newer remote body survives. */
async function staleRemoteScenario(context: ConvergenceContext): Promise<ScenarioObservation[]> {
  const key = context.namespace.key("convergence/stale-remote.md");
  requireLocalAbsent(context, key);
  await context.vault.createBinary(key, utf8("stale remote v1"));

  const first = await observe(context, [key]);
  requireOperation(first.plan, key, "upload");
  require(requireOutcome(await executePlan(context, first.plan), key).status === "applied", "the establishing upload did not apply");

  const baseline = namespacePrevious(await context.state.loadAll(), context.namespace).get(key);
  const etagA = baseline?.remote?.etag;
  require(etagA, "the establishing upload produced no committed ETag");

  const localFile = context.vault.getFileByPath(key);
  if (!localFile) throw new ScenarioFailure(`local file ${key} disappeared before the local edit`);
  await context.vault.modifyBinary(localFile, utf8("stale remote v2 local edit"));

  // The plan is taken after the local edit and *before* the external write, so the external
  // write is exactly the "remote moved after planning" case.
  const stale = requireOperation((await observe(context, [key])).plan, key, "upload");
  require(stale.expectedRemote.kind === "etag" && stale.expectedRemote.value === etagA, "the update did not carry the observed ETag precondition");

  const external = utf8("external newer content v3");
  const etagB = (await context.client.putObject(key, external, { ifMatch: etagA })).etag;
  require(etagB && etagB !== etagA, "the external write did not advance the remote ETag");

  const outcomes = await executePlan(context, { operations: [stale] });
  const upload = requireOutcome(outcomes, key);
  require(upload.status === "stale", `the stale upload returned ${upload.status} instead of stale`);
  require(upload.reason === "remote-changed", `the stale upload was classified as ${upload.reason}`);

  const unchanged = namespacePrevious(await context.state.loadAll(), context.namespace).get(key);
  require(unchanged?.remote?.etag === etagA, "previous state was mutated by a stale remote precondition failure");
  require(sameBytes(await context.client.getObject(key), external), "the stale upload overwrote newer remote content");

  return [
    observation("plan before the external write", "upload"),
    observation("execution", `${upload.status}/${upload.reason}`),
    observation("previous state mutated", false),
    observation("newer remote body preserved", true),
  ];
}

/** Phase 14: a local change after planning is stale, and the newer local content survives. */
async function staleLocalScenario(context: ConvergenceContext): Promise<ScenarioObservation[]> {
  const key = context.namespace.key("convergence/stale-local.md");
  requireLocalAbsent(context, key);

  const remoteBody = utf8("remote-only content v1");
  await context.client.putObject(key, remoteBody, { ifNoneMatch: "*" });

  const planned = requireOperation((await observe(context, [key])).plan, key, "download");
  require("kind" in planned.expectedLocal, "the download did not require an absent local target");

  const localBody = utf8("local content created after the plan");
  await context.vault.createBinary(key, localBody);

  const outcomes = await executePlan(context, { operations: [planned] });
  const download = requireOutcome(outcomes, key);
  require(download.status === "stale", `the stale download returned ${download.status} instead of stale`);
  require(download.reason === "local-changed", `the stale download was classified as ${download.reason}`);

  const localFile = context.vault.getFileByPath(key);
  if (!localFile) throw new ScenarioFailure("the local file vanished during the stale download");
  require(sameBytes(await context.vault.readBinary(localFile), localBody), "the download overwrote newer local content");
  require(!namespacePrevious(await context.state.loadAll(), context.namespace).has(key), "previous state was mutated by a stale local precondition failure");

  return [
    observation("plan", "download into an absent local target"),
    observation("execution", `${download.status}/${download.reason}`),
    observation("newer local body preserved", true),
    observation("previous state mutated", false),
  ];
}

/** Phase 16: a successful R2 write with a failed state commit is unresolved and not rolled back. */
async function stateCommitFailureScenario(context: ConvergenceContext): Promise<ScenarioObservation[]> {
  const key = context.namespace.key("convergence/state-failure.md");
  const body = utf8("state failure payload v1");
  requireLocalAbsent(context, key);
  await context.vault.createBinary(key, body);

  const planned = requireOperation((await observe(context, [key])).plan, key, "upload");

  const failing: ConvergenceContext = { ...context, state: new FailingStateStore(context.state) };
  const upload = requireOutcome(await executePlan(failing, { operations: [planned] }), key);
  require(upload.status === "unresolved", `a failed state commit returned ${upload.status} instead of unresolved`);
  require(upload.reason === "state-commit-failed", `the unresolved upload was classified as ${upload.reason}`);
  require(sameBytes(await context.client.getObject(key), body), "the successful R2 write was rolled back after the state commit failed");
  require(!namespacePrevious(await context.state.loadAll(), context.namespace).has(key), "a failed state commit still produced a committed baseline");

  return [
    observation("execution", `${upload.status}/${upload.reason}`),
    observation("R2 write preserved", true),
    observation("previous state committed", false),
  ];
}

/** Phase 15: a PUT whose outcome is unknown must not commit previous state. */
async function ambiguousPutScenario(context: ConvergenceContext, client: R2Client): Promise<ScenarioObservation[]> {
  const key = context.namespace.key("convergence/ambiguous.md");
  const body = utf8("ambiguous put payload v1");
  requireLocalAbsent(context, key);
  await context.vault.createBinary(key, body);

  const planned = requireOperation((await observe(context, [key])).plan, key, "upload");

  const upload = requireOutcome(await executePlan(context, { operations: [planned] }, client), key);
  require(upload.status === "unresolved", `an ambiguous PUT returned ${upload.status} instead of unresolved`);
  require(upload.reason === "ambiguous-put", `the ambiguous PUT was classified as ${upload.reason}`);
  require(!namespacePrevious(await context.state.loadAll(), context.namespace).has(key), "an ambiguous PUT committed previous state");

  const landed = await headOrAbsent(context.client, key);
  require(landed, "the injected fault did not actually deliver the PUT to R2");
  require(sameBytes(await context.client.getObject(key), body), "the delivered PUT stored unexpected bytes");

  return [
    observation("execution", `${upload.status}/${upload.reason}`),
    observation("previous state committed", false),
    observation("remote object present", true),
  ];
}
