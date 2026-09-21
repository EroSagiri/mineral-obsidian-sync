import type { Vault } from "obsidian";
import { GuardedIntegrationClient } from "../../src/dev/integration/guarded-client";
import { resolveLocalScratch } from "../../src/dev/integration/local-scratch";
import type { LocalScratch } from "../../src/dev/integration/local-scratch";
import { IntegrationTestNamespace } from "../../src/dev/integration/test-namespace";
import { SignedR2ListClient, remoteIdentity } from "../../src/remote/r2-client";
import type { R2Configuration } from "../../src/remote/r2-client";
import { FakeR2 } from "./fake-r2";
import type { FakeR2Options } from "./fake-r2";

/** Fixtures shared by the in-process integration tests. None of these values are real. */
export const RUN_ID = "20260922T001500Z";
export const FIXED_NOW = new Date("2026-09-22T00:15:00.000Z");
export const CONFIG: R2Configuration = {
  endpoint: "https://account-id.r2.cloudflarestorage.com",
  bucket: "integration-bucket",
  accessKeyId: "integration-access-key-id",
  secretAccessKey: "integration-secret-access-key",
  remotePrefix: "sync",
};

export interface Harness {
  fake: FakeR2;
  namespace: IntegrationTestNamespace;
  /** Real signer + real RequestUrlTransport, with requestUrl routed to the emulator. */
  client: GuardedIntegrationClient;
  identity: ReturnType<typeof remoteIdentity>;
}

export function createHarness(options: FakeR2Options = { bucket: CONFIG.bucket, accessKeyId: CONFIG.accessKeyId }, runId = RUN_ID): Harness {
  const fake = new FakeR2(options);
  const namespace = IntegrationTestNamespace.fromRunId(runId);
  const inner = new SignedR2ListClient({ ...CONFIG }, () => FIXED_NOW);
  const client = new GuardedIntegrationClient(inner, CONFIG.remotePrefix, {
    configuredPrefix: CONFIG.remotePrefix,
    objectRoot: namespace.objectRoot,
    localRoot: namespace.root,
  });
  return { fake, namespace, client, identity: remoteIdentity(CONFIG) };
}

export interface ConvergenceHarness extends Harness {
  scratch: LocalScratch;
  convergenceClient: GuardedIntegrationClient;
  convergenceIdentity: ReturnType<typeof remoteIdentity>;
}

/** Mirrors `runner.ts`: resolve the local scratch root, then scope the R2 prefix to it. */
export async function createConvergenceHarness(vault: unknown, options: FakeR2Options = { bucket: CONFIG.bucket, accessKeyId: CONFIG.accessKeyId }, runId = RUN_ID): Promise<ConvergenceHarness> {
  const base = createHarness(options, runId);
  const resolution = await resolveLocalScratch(vault as Vault, base.namespace, CONFIG.remotePrefix);
  if (!resolution.ok) throw new Error(`local scratch resolution failed: ${resolution.diagnostics.join(" | ")}`);
  const scratch = resolution.scratch;
  const config: R2Configuration = { ...CONFIG, remotePrefix: scratch.clientPrefix };
  const convergenceClient = new GuardedIntegrationClient(new SignedR2ListClient(config, () => FIXED_NOW), scratch.clientPrefix, {
    configuredPrefix: CONFIG.remotePrefix,
    objectRoot: scratch.objectRoot,
    localRoot: scratch.root,
  });
  return { ...base, scratch, convergenceClient, convergenceIdentity: remoteIdentity(config) };
}
