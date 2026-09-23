#!/usr/bin/env node
/**
 * Reads the generation the deployed Sync Gateway holds for this vault's channel.
 *
 * This is the observation point for the mutation-ingress end-to-end test. A landed write has three ways
 * to reach another device (the plugin's own `/dirty` call, and the Vault's publish of a journaled
 * mutation), and only the second one requires the ingress report to have succeeded. With the plugin's
 * single-announcer mode on, one write can therefore only move this number through the journal.
 *
 * Usage:
 *   node scripts/verify-mutation-ingress.mjs <gatewayBaseUrl> <gatewayToken> <r2Endpoint> <bucket> [prefix]
 *   node scripts/verify-mutation-ingress.mjs --from-settings <path-to-plugin-data.json>
 *   ... --watch [timeoutSeconds]
 *
 * `--from-settings` reads the endpoint, bucket, prefix and Gateway token from a vault's own plugin
 * settings, so no credential has to appear on a command line. It reads only: no write, no mutation, no
 * R2 object is touched, and the token never reaches the output.
 */
import { readFileSync } from "node:fs";
import https from "node:https";
import { deriveRemoteChangeChannel } from "@mineral/sync-core/channel";

const argv = process.argv.slice(2);
const watchIndex = argv.indexOf("--watch");
const watchValue = watchIndex >= 0 ? argv[watchIndex + 1] : undefined;
const settingsIndex = argv.indexOf("--from-settings");
const settingsPath = settingsIndex >= 0 ? argv[settingsIndex + 1] : undefined;
const positional = argv.filter((value, index) => {
  if (watchIndex >= 0 && (index === watchIndex || index === watchIndex + 1)) return false;
  if (settingsIndex >= 0 && (index === settingsIndex || index === settingsIndex + 1)) return false;
  return !value.startsWith("--");
});
const fromSettings = settingsPath ? JSON.parse(readFileSync(settingsPath, "utf8")) : undefined;
const [gatewayArg, tokenArg, endpointArg, bucketArg, prefixArg = ""] = positional;
const gateway = gatewayArg ?? fromSettings?.gatewayEndpoint;
const token = tokenArg ?? fromSettings?.gatewayToken;
const endpoint = endpointArg ?? fromSettings?.endpoint;
const bucket = bucketArg ?? fromSettings?.bucket;
const prefix = positional.length >= 5 ? prefixArg : fromSettings?.remotePrefix ?? "";
const watchSeconds = Number(watchValue) || 120;

if (!gateway || !token || !endpoint || !bucket) {
  console.error("usage: verify-mutation-ingress.mjs <gatewayBaseUrl> <gatewayToken> <r2Endpoint> <bucket> [prefix] [--watch seconds]");
  console.error("       verify-mutation-ingress.mjs --from-settings <plugin data.json> [--watch seconds]");
  process.exit(2);
}

const channel = await deriveRemoteChangeChannel({ endpoint, bucket, remotePrefix: prefix });
const fingerprint = `${channel.slice(0, 6)}…(${channel.length})`;

/**
 * One authenticated GET, over `node:https` rather than global `fetch`.
 *
 * This machine's transparent proxy resets undici's TLS handshake to some Cloudflare hosts while plain
 * HTTP/1.1 over TLS is fine, and a check that fails intermittently is worse than no check.
 */
const get = (url, headers) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const request = https.request({ host: target.hostname, port: 443, path: `${target.pathname}${target.search}`, method: "GET", headers, timeout: 15_000 }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
  });
  request.on("error", reject);
  request.on("timeout", () => request.destroy(new Error("gateway read timed out")));
  request.end();
});

const generation = async () => {
  const response = await get(`${gateway.replace(/\/+$/, "")}/v1/channels/${channel}`, { authorization: `Bearer ${token}` });
  if (response.status < 200 || response.status >= 300) throw new Error(`gateway read failed: HTTP ${response.status}`);
  let body;
  try { body = JSON.parse(response.text); } catch { throw new Error("gateway read returned no JSON"); }
  if (typeof body?.generation !== "string") throw new Error("gateway read returned no generation");
  return body.generation;
};

const before = await generation();
console.log(`channel=${fingerprint} generation=${before}`);
if (watchIndex < 0) process.exit(0);

console.log(`watching for a generation change (up to ${watchSeconds}s) — make one write in the vault now`);
const deadline = Date.now() + watchSeconds * 1000;
let previous = before;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  let current;
  try { current = await generation(); }
  catch (error) { console.log(`  read failed: ${error.message}`); continue; }
  if (current !== previous) {
    console.log(`generation=${current} (moved from ${before}) — a write reached the Gateway`);
    process.exit(0);
  }
}
console.log(`no change within ${watchSeconds}s — nothing reached the Gateway`);
process.exit(1);
