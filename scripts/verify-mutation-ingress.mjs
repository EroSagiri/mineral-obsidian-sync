#!/usr/bin/env node
/**
 * Reads the generation the deployed Sync Gateway holds for this vault's channel.
 *
 * This is the observation point for the mutation-ingress end-to-end test. A landedy write has three ways
 * to reach another device (the plugin's own `/dirty` call, and the Vault's publish of a journaled
 * mutation), and only the second one requires the ingress report to have succeeded. So the check is:
 * disable the plugin's direct write to Gateway, make one write, and watch this number move.
 *
 * Usage:
 *   node scripts/verify-mutation-ingress.mjs <gatewayBaseUrl> <gatewayToken> <r2Endpoint> <bucket> [prefix]
 *   node scripts/verify-mutation-ingress.mjs ... --watch [timeoutSeconds]
 *
 * It reads only: no write, no mutation, no R2 object is touched. The token never reaches the output.
 */
import { deriveRemoteChangeChannel } from "@mineral/sync-core/channel";

const argv = process.argv.slice(2);
const watchIndex = argv.indexOf("--watch");
const watchValue = watchIndex >= 0 ? argv[watchIndex + 1] : undefined;
const positional = argv.filter((value, index) => {
  if (watchIndex >= 0 && (index === watchIndex || index === watchIndex + 1)) return false;
  return !value.startsWith("--");
});
const [gateway, token, endpoint, bucket, prefix = ""] = positional;
const watchSeconds = Number(watchValue) || 120;

if (!gateway || !token || !endpoint || !bucket) {
  console.error("usage: verify-mutation-ingress.mjs <gatewayBaseUrl> <gatewayToken> <r2Endpoint> <bucket> [prefix] [--watch seconds]");
  process.exit(2);
}

const channel = await deriveRemoteChangeChannel({ endpoint, bucket, remotePrefix: prefix });
const fingerprint = `${channel.slice(0, 6)}…(${channel.length})`;
const generation = async () => {
  const response = await fetch(`${gateway.replace(/\/+$/, "")}/v1/channels/${channel}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`gateway read failed: HTTP ${response.status}`);
  const body = await response.json();
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
