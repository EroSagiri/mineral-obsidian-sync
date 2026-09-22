/**
 * Diagnostic conditional PUT, guarded so it can never overwrite an existing object.
 *
 * Usage: node scripts/r2-put.mjs <windowsVaultDir> <key> <fileToUpload>
 * Uses `If-None-Match: *`, so it fails with 412 if the key already exists.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignedR2ListClient } from "../build-diag/diag.mjs";
import { NodeFetchTransport } from "./node-fetch-transport.mjs";

const [, , windowsVault, key, sourceFile] = process.argv;
if (!windowsVault || !key || !sourceFile) { console.error("usage: node scripts/r2-put.mjs <windowsVaultDir> <key> <file>"); process.exit(2); }

const dataJson = JSON.parse(readFileSync(join(windowsVault, ".obsidian", "plugins", "mineral-obsidian-sync", "data.json"), "utf8"));
const config = { endpoint: dataJson.endpoint, bucket: dataJson.bucket, accessKeyId: dataJson.accessKeyId, secretAccessKey: dataJson.secretAccessKey, remotePrefix: dataJson.remotePrefix ?? "" };
const client = new SignedR2ListClient(config, () => new Date(), undefined, new NodeFetchTransport());

const bytes = readFileSync(sourceFile);
const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const version = await client.putObject(key, body, { ifNoneMatch: "*" });
console.log(`PUT ok: key=${key} size=${version.size} etag=${version.etag}`);
