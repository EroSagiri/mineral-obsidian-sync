/** Disposable isolated R2 namespace. Never uses the configured ordinary prefix. */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { NodeFetchTransport } from './node-fetch-transport.mjs';
const [bundle, settingsFile, output, countText = '12', concurrencyText = '1'] = process.argv.slice(2);
const { SignedR2ListClient, remoteIdentity, SafeExecutor, RecoveryStore, recoverySelection } = await import(pathToFileURL(bundle));
const count = Number(countText);
const concurrency = Number(concurrencyText);
if (![1, 4].includes(concurrency)) throw Error('Invalid concurrency');
if (!Number.isInteger(count) || count < 1 || count > 100) throw Error('Invalid count');
const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
settings.remotePrefix = `mineral-bulk-benchmark/${randomUUID()}/`;
const requests = [];
const timings = [];
const transport = new NodeFetchTransport();
const client = new SignedR2ListClient(settings, undefined, undefined, { send: async request => {
  const url = new URL(request.url), method = request.method;
  const path = decodeURIComponent(url.pathname);
  const stage = url.searchParams.has('list-type') ? 'scan' : path.includes('/tombstones/') ? 'tombstone' : path.endsWith('/manifest.toml') ? 'manifest' : path.includes('/.mineral/versions/') ? 'backup-body' : method === 'DELETE' ? 'delete' : method === 'HEAD' && !request.headers['if-match'] ? 'verify-absence' : 'source-validation-read';
  const start = performance.now();
  try { return await transport.send(request); }
  finally { timings.push({ stage, method, ms: Math.round(performance.now() - start) }); }
} }, message => requests.push(message));
const port = client.recoveryPort(), identity = remoteIdentity(settings), store = new RecoveryStore(port, JSON.stringify(identity));
const report = { prefix: settings.remotePrefix, count, phases: {}, remaining: 'unknown' };
const save = () => writeFileSync(output, JSON.stringify(report, null, 2));
save();
const state = { delete: async () => {}, put: async () => {}, loadAll: async () => new Map() };
let notifications = 0;
const executor = new SafeExecutor({}, client, state, identity, '', undefined, undefined, undefined, { defer: concurrency > 1, confirmDelete: async () => true, changed: async () => { notifications++; } });
async function measure(name, fn) {
  requests.length = 0; timings.length = 0; const start = performance.now();
  const result = await fn();
  report.phases[name] = { ms: Math.round(performance.now() - start), requests: requests.length, operations: {} };
  for (const line of requests) { const match = /operation=(\S+).*durationMs=(\d+)/.exec(line); if (!match) continue; const item = report.phases[name].operations[match[1]] ??= { count: 0, ms: 0 }; item.count++; item.ms += Number(match[2]); }
  report.phases[name].stages = {};
  for (const timing of timings) { const item = report.phases[name].stages[`${timing.stage}:${timing.method}`] ??= { count: 0, ms: 0 }; item.count++; item.ms += timing.ms; }
  save(); return result;
}
try {
  const operations = [];
  for (let i = 0; i < count; i++) { const key = `folder/note-${i}.md`; const o = await port.put(key, new TextEncoder().encode(`Disposable ${i}\n`), null); operations.push({ type: 'delete-remote', key, reason: 'local-deleted', expectedRemoteETag: o.etag }); }
  const results = await measure('delete', async () => { const out = []; for (let i = 0; i < operations.length; i += concurrency) out.push(...await Promise.all(operations.slice(i, i + concurrency).map(op => executor.execute(op)))); await executor.flushRecoveryChanges?.(); return out; });
  report.results = results; report.notifications = notifications;
  await measure('reconcile', () => executor.retryRecoveryDeletes());
  if (results.some(r => r.status !== 'applied')) throw Error('Deletion incomplete');
} finally {
  // All operations are scoped by a newly generated prefix; cleanup still uses recovery intents.
  for (const o of await client.listObjects()) await executor.executeRecovery({ identity: store.identity, confirmed: true, action: 'delete', path: o.key, etag: o.etag });
  await executor.retryRecoveryDeletes();
  const entries = await store.list();
  if (entries.length) await executor.executeRecovery({ identity: store.identity, confirmed: true, action: 'clean', selections: entries.map(recoverySelection) });
  report.remaining = (await client.listObjects()).length + (await store.list()).length; save();
}
console.log(JSON.stringify(report));
