import { readFileSync } from "node:fs";
import https from "node:https";
import { setRequestUrlHandler } from "../test/obsidian";
import { remoteIdentity, SignedR2ListClient } from "../src/remote/r2-client";
import { createMutationIngressReporter, mutationIngressConfig } from "../src/gateway/mutation-ingress";
import { RequestUrlGatewayTransport } from "../src/gateway/transport";
import type { R2Configuration } from "../src/remote/r2-client";
import type { LandedWrite } from "../src/gateway/mutation-ingress";

/**
 * Verifies the *client* half of the mutation ingress against the deployed Vault.
 *
 * This runs the very code the plugin ships — the same reporter, the same transport, the same mutation
 * body — against the real ingress, with a real R2 object so the server's ETag verification is actually
 * exercised. It is the check that can be made without an Obsidian reload; the in-situ run (a real write
 * in a real vault) is `npm run verify:ingress` plus the Vault's own log.
 *
 * It writes exactly one scratch object under `.mineral-sync-test/` (the namespace this repository's own
 * self-test already uses), reports a put and a logical delete for it, and removes it physically at the
 * end. No other key is touched, and nothing here prints a credential.
 *
 * Usage: node scripts/verify-mutation-ingress-client.mjs <path-to-plugin-data.json>
 * (bundled from scripts/verify-mutation-ingress-client.ts; see the header of that file for the command)
 */

const settingsPath = process.argv[2];
if (!settingsPath) {
  console.error("usage: verify-mutation-ingress-client.mjs <plugin data.json>");
  process.exit(2);
}
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
// The shipped transport timeouts through `window.setTimeout`; Obsidian provides it, Node does not.
(globalThis as unknown as { window: unknown }).window = globalThis;
const config: R2Configuration = {
  endpoint: settings.endpoint,
  bucket: settings.bucket,
  accessKeyId: settings.accessKeyId,
  secretAccessKey: settings.secretAccessKey,
  remotePrefix: settings.remotePrefix ?? "",
};

// The plugin's transport targets Obsidian's `requestUrl`; in Node the stub is backed by `node:https`.
// Global `fetch` is deliberately not used: this machine's transparent proxy resets undici's TLS to the
// R2 host while plain HTTP/1.1 over TLS works, and the response headers must survive either way because
// the R2 client reads the PUT's ETag from them.
setRequestUrlHandler(async (request) => new Promise((resolve, reject) => {
  const url = new URL(request.url);
  const sent = https.request({
    host: url.hostname,
    port: url.port ? Number(url.port) : 443,
    path: `${url.pathname}${url.search}`,
    method: request.method ?? "GET",
    headers: request.headers,
    timeout: 20_000,
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => {
      const buffer = Buffer.concat(chunks);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) if (typeof value === "string") headers[name] = value;
      resolve({
        status: response.statusCode ?? 0,
        headers,
        text: buffer.toString("utf8"),
        arrayBuffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
        json: {},
      });
    });
  });
  sent.on("error", reject);
  sent.on("timeout", () => sent.destroy(new Error("request timed out")));
  if (request.body) sent.write(typeof request.body === "string" ? request.body : Buffer.from(request.body as ArrayBuffer));
  sent.end();
}));

const client = new SignedR2ListClient(config);
const identity = remoteIdentity(config);
const scratch = `.mineral-sync-test/ingress-probe-${Date.now()}.md`;
const bytes = new TextEncoder().encode(`# ingress probe\n\nwritten ${new Date().toISOString()}\n`);
const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const logs: string[] = [];
const reporter = createMutationIngressReporter({
  settings: () => mutationIngressConfig(settings),
  transport: new RequestUrlGatewayTransport(),
  now: () => Date.now(),
  debug: (message) => logs.push(message),
});

const verdict = (expectation: "recorded" | "rejected" | "deferred"): string => {
  if (logs.some((line) => line.startsWith("mutation ingress recorded"))) return "recorded";
  if (logs.some((line) => line.startsWith("mutation ingress rejected"))) return "rejected";
  if (logs.some((line) => line.startsWith("mutation ingress deferred"))) return "deferred";
  return "nothing-sent";
};

let failures = 0;
const check = (label: string, actual: string, expected: string): void => {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
  if (!ok || process.env.VERBOSE_INGRESS_PROBE) for (const line of logs) console.log(`        · ${line}`);
};

console.log(`namespace  ${identity.endpoint} / ${identity.bucket} / "${identity.remotePrefix}"`);
console.log(`ingress    ${settings.mutationIngressEndpoint}  enabled=${settings.mutationIngressEnabled} token=<${String(settings.mutationIngressToken ?? "").length} chars>`);

try {
  const written = await client.putObject(scratch, body, { ifNoneMatch: "*" });
  console.log(`r2 put     ${scratch} -> etag=${written.etag} size=${written.size}`);

  const put: LandedWrite = { op: "put", path: scratch, etag: written.etag!, size: written.size };
  logs.length = 0;
  await reporter.report([put]);
  const putVerdict = verdict("recorded");
  check("put report accepted by the live ingress", putVerdict, "recorded");
  check("put report left nothing pending", String(reporter.pendingCount()), "0");

  // A logical delete: the object is still there, and the report names the revision it retires.
  const deleted: LandedWrite = { op: "delete", path: scratch, etag: written.etag! };
  logs.length = 0;
  await reporter.report([deleted]);
  const deleteVerdict = verdict("recorded");
  check("logical delete report accepted", deleteVerdict, "recorded");
  check("delete report left nothing pending", String(reporter.pendingCount()), "0");

  // A report that does not describe R2 must be refused, and must not be retried.
  logs.length = 0;
  await reporter.report([{ op: "put", path: scratch, etag: "00000000000000000000000000000000", size: written.size }]);
  check("stale revision refused", verdict("rejected"), "rejected");
  check("refused report is not queued", String(reporter.pendingCount()), "0");
} finally {
  try { await client.deleteObject?.(scratch); console.log(`r2 delete  ${scratch} (scratch cleaned up)`); }
  catch (error) { console.log(`r2 delete  failed: ${error instanceof Error ? error.message : "unknown"}`); }
}

console.log(failures === 0 ? "client verification: PASS" : `client verification: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
