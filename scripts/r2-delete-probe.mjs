/** Removes this session's diagnostic probe objects from R2, guarded by If-Match. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignedR2ListClient, deleteObjectIfMatch } from "../build-diag/diag.mjs";
import { NodeFetchTransport } from "./node-fetch-transport.mjs";

const [, , windowsVault, ...keys] = process.argv;
if (!windowsVault || !keys.length) { console.error("usage: node scripts/r2-delete-probe.mjs <windowsVaultDir> <key>..."); process.exit(2); }

const dataJson = JSON.parse(readFileSync(join(windowsVault, ".obsidian", "plugins", "mineral-obsidian-sync", "data.json"), "utf8"));
const config = { endpoint: dataJson.endpoint, bucket: dataJson.bucket, accessKeyId: dataJson.accessKeyId, secretAccessKey: dataJson.secretAccessKey, remotePrefix: dataJson.remotePrefix ?? "" };
const client = new SignedR2ListClient(config, () => new Date(), undefined, new NodeFetchTransport());
const listed = await client.listObjects();

for (const key of keys) {
  const entry = listed.find((candidate) => candidate.key === key);
  if (!entry) { console.log(`skip (not in R2): ${key}`); continue; }
  if (!entry.etag) { console.log(`skip (no etag to guard with): ${key}`); continue; }
  const status = await deleteObjectIfMatch(config, key, entry.etag);
  console.log(`${status === 204 || status === 200 ? "deleted" : `HTTP ${status}`}: ${key}`);
}
