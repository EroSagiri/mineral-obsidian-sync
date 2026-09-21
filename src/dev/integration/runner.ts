import type { App } from "obsidian";
import { remoteIdentity, SignedR2ListClient } from "../../remote/r2-client";
import type { R2Configuration } from "../../remote/r2-client";
import type { R2SyncSettings } from "../../settings";
import { IndexedDbStateStore } from "../../state/state-store";
import { ignorePolicyFingerprint } from "../../sync/ignore";
import { convergenceScenarioNames, lostResponseClient, runConvergenceScenarios } from "./convergence";
import { GuardedIntegrationClient } from "./guarded-client";
import { resolveLocalScratch } from "./local-scratch";
import { observation, redactReport, skipScenario } from "./result";
import type { ScenarioReport, ScenarioResult } from "./result";
import { runTransportScenarios } from "./scenarios";
import { IntegrationTestNamespace } from "./test-namespace";

/**
 * In-Obsidian runner for Phase 2A.5.
 *
 * This is a diagnostic, not a synchronization feature. It never writes to a canonical R2 key:
 * every object key is forced inside `.mineral-sync-test/<run-id>/` and verified on the mapped
 * object key, whatever the local scratch path turns out to be.
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
  const ignorePolicy = ignorePolicyFingerprint(settings);
  const results: ScenarioResult[] = [];

  if (selection.transport) {
    const transportClient = new GuardedIntegrationClient(new SignedR2ListClient(config), config.remotePrefix, {
      configuredPrefix: config.remotePrefix,
      objectRoot: namespace.objectRoot,
      localRoot: namespace.root,
    });
    results.push(...(await runTransportScenarios({ namespace, client: transportClient })));
  }

  if (selection.convergence) {
    const resolution = await resolveLocalScratch(app.vault, namespace, config.remotePrefix);
    if (!resolution.ok) {
      results.push({ name: "local-scratch-root", status: "fail", detail: "no usable Vault scratch root; see the probe trail", observations: resolution.diagnostics.map((entry) => observation("probe", entry)) });
      results.push(...convergenceScenarioNames().map((name) => skipScenario(name, "no usable local Vault scratch root")));
    } else {
      const scratch = resolution.scratch;
      results.push({
        name: "local-scratch-root",
        status: "pass",
        detail: `using the ${scratch.kind} local scratch root`,
        observations: [...scratch.diagnostics.map((entry) => observation("probe", entry)), observation("local scratch root", scratch.root), observation("r2 object root", `${config.remotePrefix}${scratch.objectRoot}`)],
      });
      const convergenceConfig: R2Configuration = { ...config, remotePrefix: scratch.clientPrefix };
      const convergenceClient = new GuardedIntegrationClient(new SignedR2ListClient(convergenceConfig), scratch.clientPrefix, {
        configuredPrefix: config.remotePrefix,
        objectRoot: scratch.objectRoot,
        localRoot: scratch.root,
      });
      results.push(...(await runConvergenceScenarios({
        vault: app.vault,
        client: convergenceClient,
        state: new IndexedDbStateStore(INTEGRATION_STATE_DATABASE),
        scratch,
        identity: remoteIdentity(convergenceConfig),
        ignorePolicy,
        ambiguousClient: lostResponseClient(convergenceClient),
      })));
    }
  }

  return redactReport(
    { runId: namespace.runId, root: namespace.root, environment: "obsidian-requesturl", startedAt, finishedAt: Date.now(), results },
    [settings.accessKeyId, settings.secretAccessKey],
  );
}
