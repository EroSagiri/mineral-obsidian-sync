import { GuardedIntegrationClient } from "../../src/dev/integration/guarded-client";
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
  return { fake, namespace, client: new GuardedIntegrationClient(inner, namespace, CONFIG.remotePrefix), identity: remoteIdentity(CONFIG) };
}
