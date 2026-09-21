import type { App } from "obsidian";
import { remoteIdentity, SignedR2ListClient } from "../../remote/r2-client";
import type { R2Configuration } from "../../remote/r2-client";
import type { R2SyncSettings } from "../../settings";
import { IndexedDbStateStore } from "../../state/state-store";
import { ignorePolicyFingerprint } from "../../sync/ignore";
import { lostResponseClient, runConvergenceScenarios } from "./convergence";
import { GuardedIntegrationClient } from "./guarded-client";
import { redactReport } from "./result";
import type { ScenarioReport, ScenarioResult } from "./result";
import { runTransportScenarios } from "./scenarios";
import { IntegrationTestNamespace } from "./test-namespace";

/**
 * In-Obsidian runner for Phase 2A.5.
 *
 * This is a diagnostic, not a synchronization feature. It never lists, reads, writes, or
 * deletes anything outside `.mineral-sync-test/<run-id>/`, and it never registers a
 * production UI entry point: the command is added only under `__DEV__`.
 */

/** A separate database keeps the real device baseline completely untouched. */
export const INTEGRATION_STATE_DATABASE = "r2-personal-sync-state-integration-test-v1";

export interface SelfTestSelection {
  transport: boolean;
  convergence: boolean;
}

function configuration(settings: R2SyncSettings): R2Configuration {
  const missing = (["endpoint", "bucket", "accessKeyId", "secretAccessKey"] as const).filter((field) => !settings[field]);
  if (missing.length) throw new Error(`R2 self-test needs these settings first: ${missing.join(", ")}`);
  if (!/^https:\/\//i.test(settings.endpoint)) throw new Error("R2 endpoint must use HTTPS");
  return {
    endpoint: settings.endpoint,
    bucket: settings.bucket,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    remotePrefix: settings.remotePrefix,
  };
}

export async function runR2SelfTest(app: App, settings: R2SyncSettings, selection: SelfTestSelection): Promise<ScenarioReport> {
  const config = configuration(settings);
  const startedAt = Date.now();
  const namespace = IntegrationTestNamespace.mint();
  const client = new SignedR2ListClient(config);
  const guarded = new GuardedIntegrationClient(client, namespace, config.remotePrefix);
  const state = new IndexedDbStateStore(INTEGRATION_STATE_DATABASE);
  const identity = remoteIdentity(config);
  const ignorePolicy = ignorePolicyFingerprint(settings);

  const results: ScenarioResult[] = [];
  if (selection.transport) {
    results.push(...(await runTransportScenarios({ namespace, client: guarded })));
  }
  if (selection.convergence) {
    results.push(...(await runConvergenceScenarios({ vault: app.vault, client: guarded, state, namespace, identity, ignorePolicy, ambiguousClient: lostResponseClient(guarded) })));
  }

  return redactReport(
    { runId: namespace.runId, root: namespace.root, environment: "obsidian-requesturl", startedAt, finishedAt: Date.now(), results },
    [settings.accessKeyId, settings.secretAccessKey],
  );
}
