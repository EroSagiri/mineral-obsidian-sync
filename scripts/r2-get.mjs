/**
 * Read-only R2 object fetch for diagnostics: confirm a specific object's bytes landed.
 *
 * Usage: node scripts/r2-get.mjs <windowsVaultDir> <key> [--metadata-only]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignedR2ListClient } from "../build-diag/diag.mjs";
import { NodeFetchTransport } from "./node-fetch-transport.mjs";

const [, , windowsVault, key] = process.argv;
if (!windowsVault || !key) { console.error("usage: node scripts/r2-get.mjs <windowsVaultDir> <key>"); process.exit(2); }

const dataJson = JSON.parse(readFileSync(join(windowsVault, ".obsidian", "plugins", "mineral-obsidian-sync", "data.json"), "utf8"));
const config = { endpoint: dataJson.endpoint, bucket: dataJson.bucket, accessKeyId: dataJson.accessKeyId, secretAccessKey: dataJson.secretAccessKey, remotePrefix: dataJson.remotePrefix ?? "" };
const client = new SignedR2ListClient(config, () => new Date(), undefined, new NodeFetchTransport());

const listed = (await client.listObjects()).find((entry) => entry.key === key);
if (!listed) { console.log(`NOT IN R2: ${key}`); process.exit(1); }
console.log(`listed: size=${listed.size} etag=${listed.etag} lastModified=${new Date(listed.lastModified).toISOString()}`);
const bytes = await client.getObject(key);
console.log(`fetched ${bytes.byteLength} bytes, matches listed size: ${bytes.byteLength === listed.size}`);
console.log(`content:\n${new TextDecoder().decode(bytes)}`);
