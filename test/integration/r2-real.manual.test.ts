import { describe, expect, it } from "vitest";
import { GuardedIntegrationClient } from "../../src/dev/integration/guarded-client";
import { formatReport, summarize } from "../../src/dev/integration/result";
import { runTransportScenarios } from "../../src/dev/integration/scenarios";
import { IntegrationTestNamespace } from "../../src/dev/integration/test-namespace";
import { SignedR2ListClient } from "../../src/remote/r2-client";
import type { R2Configuration } from "../../src/remote/r2-client";
import { installDomParserShim } from "./dom-parser-shim";
import { NodeFetchTransport } from "./node-fetch-transport";

/**
 * Opt-in diagnostic against a **real** Cloudflare R2 bucket, over Node `fetch`.
 *
 * It is deliberately not part of `npm test`: it only runs when the `MINERAL_TEST_R2_*`
 * environment variables are present. It exercises real aws4fetch signing, real conditional
 * create/update/GET, real binary bodies and real R2 error codes — but it bypasses Obsidian's
 * `requestUrl`, so **a pass here must never be reported as "requestUrl integration passed"**.
 * Use the in-Obsidian self-test command for that.
 *
 * All keys are minted inside `.mineral-sync-test/<run-id>/` and every call goes through the
 * hard test-prefix guard. Nothing is deleted; the run prefix is reported for manual cleanup.
 */

const env = {
  endpoint: process.env.MINERAL_TEST_R2_ENDPOINT?.trim() ?? "",
  bucket: process.env.MINERAL_TEST_R2_BUCKET?.trim() ?? "",
  accessKeyId: process.env.MINERAL_TEST_R2_ACCESS_KEY_ID?.trim() ?? "",
  secretAccessKey: process.env.MINERAL_TEST_R2_SECRET_ACCESS_KEY?.trim() ?? "",
  remotePrefix: process.env.MINERAL_TEST_R2_PREFIX?.trim() ?? "",
};

const configured = Boolean(env.endpoint && env.bucket && env.accessKeyId && env.secretAccessKey);

describe.skipIf(!configured)("real Cloudflare R2 over Node fetch (diagnostic only — never proof of requestUrl)", () => {
  it("passes every transport scenario against the real endpoint", async () => {
    installDomParserShim();
    const config: R2Configuration = { ...env };
    const namespace = IntegrationTestNamespace.mint();
    const client = new GuardedIntegrationClient(new SignedR2ListClient(config, () => new Date(), undefined, new NodeFetchTransport()), config.remotePrefix, {
      configuredPrefix: config.remotePrefix,
      objectRoot: namespace.objectRoot,
      localRoot: namespace.root,
    });

    const startedAt = Date.now();
    const results = await runTransportScenarios({ namespace, client });
    const report = { runId: namespace.runId, root: namespace.root, environment: "node-fetch-diagnostic", startedAt, finishedAt: Date.now(), results };
    console.log(`\n${formatReport(report)}\n`);

    expect(summarize(report).failed).toBe(0);
    expect(results.every((result) => result.status === "pass")).toBe(true);
  }, 300_000);
});
