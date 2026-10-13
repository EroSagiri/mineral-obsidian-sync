/** Disposable, prefix-scoped verification using the real client and SafeExecutor. No credentials in output. */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SignedR2ListClient, remoteIdentity, SafeExecutor, RecoveryStore, recoverySelection, deriveRemoteChangeChannel } from "../build-diag/recovery.mjs";
import { NodeFetchTransport } from "./node-fetch-transport.mjs";
const [mode, vault, checkpoint] = process.argv.slice(2);
if (!mode || !vault || !checkpoint) throw new Error("usage: verify-recovery-live.mjs <setup|check|cleanup> <vault> <checkpoint.json>");
const settings = JSON.parse(readFileSync(join(vault, ".obsidian/plugins/mineral-obsidian-sync/data.json"), "utf8"));
const client = new SignedR2ListClient(settings, undefined, undefined, new NodeFetchTransport());
const identity = remoteIdentity(settings); const port = client.recoveryPort(); const store = new RecoveryStore(port, JSON.stringify(identity));
const state = { loadAll: async () => new Map(), saveAll: async () => {}, saveVerified: async () => {}, put: async () => {}, delete: async () => {} };
const channel = await deriveRemoteChangeChannel(identity);
const report = mode === "setup" ? { root: `mineral-recovery-test/${randomUUID()}/`, time: new Date().toISOString(), checks: {} } : JSON.parse(readFileSync(checkpoint, "utf8"));
if (!/^mineral-recovery-test\/[0-9a-f-]+\/$/.test(report.root)) throw new Error("Unsafe test namespace");
const owned = path => path.startsWith(report.root);
async function notify() {
  if (!settings.gatewayEnabled) return;
  try { const r = await fetch(`${settings.gatewayEndpoint.replace(/\/+$/, "")}/v1/channels/${channel}/dirty`, { method: "POST", headers: { Authorization: `Bearer ${settings.gatewayToken}`, "content-type": "application/json" }, body: JSON.stringify({ source: "obsidian", kind: "unknown", mutationId: `recovery-${randomUUID()}` }), signal: AbortSignal.timeout(10000) }); report.gatewayLastStatus = r.status; await r.arrayBuffer(); } catch { report.gatewayLastStatus = "offline"; }
}
const executor = new SafeExecutor({}, client, state, identity, "", undefined, undefined, undefined, { confirmDelete: async () => true, changed: notify });
const offlineExecutor = new SafeExecutor({}, client, state, identity, "", undefined, undefined, undefined, { confirmDelete: async () => true, changed: async () => { report.checks.offlineNotificationAttempted = true; await fetch("http://127.0.0.1:1/unavailable-gateway", { signal: AbortSignal.timeout(1000) }); } });
const command = async (exec, input) => exec.executeRecovery({ identity: store.identity, confirmed: true, ...input });
const check = (name, passed) => { report.checks[name] = Boolean(passed); if (!passed) { writeFileSync(checkpoint, JSON.stringify(report, null, 2)); throw new Error(`Failed check: ${name}`); } };
if (mode === "setup") {
  report.path = `${report.root}note.md`; report.content = `# Mineral recovery 0.0.3\n\nDisposable test ${report.root}\n`;
  writeFileSync(checkpoint, JSON.stringify(report, null, 2));
  await port.put(report.path, new TextEncoder().encode(report.content), null, { owner: "recovery-test" }, "text/markdown");
  await notify(); check("sourceCreated", Boolean(await port.head(report.path)));
} else if (mode === "check") {
  const current = await port.head(report.path); if (!current) throw new Error("Setup source missing");
  await command(executor, { action: "delete", path: report.path, etag: current.etag });
  check("physicalDelete404", await port.head(report.path) === null);
  const entry = (await store.list()).find(e => e.path === report.path && e.kind === "version");
  check("deleteVersionAndRiskRecord", entry?.state === "deleted" && entry.manifest.anomaly.includes("delete-window"));
  report.deleteVersionId = entry.manifest.version_id;
  report.selection = recoverySelection(entry);
  // Restore remains for the Windows UI portion of the acceptance test.
  report.restoredPath = report.path;
  const binary = `${report.root}offline.bin`; const bin = new Uint8Array([0, 255, 128, 13, 10]);
  const original = await port.put(binary, bin, null, { owner: "binary-test" }, "application/octet-stream");
  const backup = await store.backup(binary, original.etag);
  const target = `${report.root}offline-restored.bin`;
  await command(offlineExecutor, { action: "restore", selection: recoverySelection(backup), target, expectedTargetETag: null });
  const head = await port.head(target); const restored = await port.read(target, head.etag);
  check("offlineBinaryRestore", restored.bytes.every((b, i) => b === bin[i]) && restored.object.metadata.owner === "binary-test");
  await command(offlineExecutor, { action: "clean", selections: [recoverySelection(backup)] });
  check("offlineSingleVersionCleanup", await port.head(backup.key) === null);
  const a = await store.backup(binary, original.etag); const b = await store.backup(binary, original.etag);
  await command(executor, { action: "clean", selections: [recoverySelection(a), recoverySelection(b)] });
  check("batchVersionCleanup", await port.head(a.key) === null && await port.head(b.key) === null);
  report.binaryPaths = [binary, target]; await notify();
} else if (mode === "cleanup") {
  for (const e of (await store.list()).filter(e => owned(e.path) && e.kind === "version" && e.state === "delete-pending")) await command(offlineExecutor, { action: "retry", selection: recoverySelection(e) });
  // Delete only ordinary test files, through the same backed-up, confirmed physical-delete sequence.
  for (const o of await client.listObjects()) if (owned(o.key)) await command(offlineExecutor, { action: "delete", path: o.key, etag: o.etag });
  for (const e of (await store.list()).filter(e => owned(e.path) && e.kind === "version" && e.state === "delete-pending")) await command(offlineExecutor, { action: "retry", selection: recoverySelection(e) });
  let entries = (await store.list()).filter(e => owned(e.path));
  if (entries.some(e => e.kind !== "version" && e.kind !== "tombstone")) throw new Error("Unsafe or incomplete test record; preserve and report");
  if (entries.length) await command(offlineExecutor, { action: "clean", selections: entries.map(recoverySelection) });
  check("testRecoveryObjectsGone", !(await store.list()).some(e => owned(e.path)));
  check("testOrdinaryObjectsGone", !(await client.listObjects()).some(e => owned(e.key)));
  report.remainingTestObjects = 0;
} else throw new Error("Unknown mode");
writeFileSync(checkpoint, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ mode, root: report.root, checks: report.checks, remainingTestObjects: report.remainingTestObjects }, null, 2));
