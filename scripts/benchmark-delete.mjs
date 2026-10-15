/** Disposable isolated R2 namespace. Never uses the configured ordinary prefix. */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { NodeFetchTransport } from './node-fetch-transport.mjs';
import { cleanupDeleteBenchmark } from './cleanup-delete-benchmark.mjs';
const [bundle, settingsFile, output, countText = '12', concurrencyText = '1', mode = 'legacy'] = process.argv.slice(2);
const { SignedR2ListClient, remoteIdentity, SafeExecutor, RecoveryStore, recoverySelection } = await import(pathToFileURL(bundle));
const count = Number(countText);
const concurrency = Number(concurrencyText);
if (![1, 4].includes(concurrency)) throw Error('Invalid concurrency');
if (!Number.isInteger(count) || count < 1 || count > 100) throw Error('Invalid count');
const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
// Reserved root prevents running production clients from importing disposable fixtures.
settings.remotePrefix = `.mineral/benchmarks/bulk-delete/${randomUUID()}/`;
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
if (!['legacy', 'backup', 'direct'].includes(mode)) throw Error('Invalid deletion mode');
const report = { prefix: settings.remotePrefix, count, mode, phases: {}, remaining: 'unknown', failures: [] };
const save = () => writeFileSync(output, JSON.stringify(report, null, 2));
save();
const state = { delete: async () => {}, put: async () => {}, loadAll: async () => new Map() };
let notifications = 0;
const executor = new SafeExecutor({}, client, state, identity, '', undefined, undefined, undefined, { deletionMode: mode === 'direct' ? 'direct' : 'backup', defer: concurrency > 1, confirmDelete: async () => true, changed: async () => { notifications++; } });
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
  for (let start = 0; start < count; start += 4) await Promise.all(Array.from({ length: Math.min(4, count - start) }, async (_, offset) => { const i = start + offset; const key = `folder/note-${i}.md`; const o = await port.put(key, new TextEncoder().encode(`Disposable ${i}\n`), null); operations.push({ type: 'delete-remote', key, reason: 'local-deleted', expectedRemoteETag: o.etag }); }));
  const convergenceStart = performance.now();
  const results = await measure('delete', async () => { const out = []; for (let i = 0; i < operations.length; i += concurrency) { const batch = operations.slice(i, i + concurrency); out.push(...mode === 'legacy' ? await Promise.all(batch.map(op => executor.execute(op))) : await executor.executeRemoteDeletes(batch)); } await executor.flushRecoveryChanges?.(); return out; });
  report.results = results; report.notifications = notifications;
  await measure('reconcile', async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await executor.retryRecoveryDeletes();
        const remaining = await client.listObjects();
        if (!remaining.length) return;
        const retry = remaining.map(object => {
          const original = operations.find(op => op.key === object.key);
          if (!original || original.expectedRemoteETag !== object.etag) throw Error('Benchmark source recreated; refusing retry');
          return original;
        });
        for (let start = 0; start < retry.length; start += concurrency) {
          const batch = retry.slice(start, start + concurrency);
          if (mode === 'legacy') await Promise.all(batch.map(op => executor.execute(op)));
          else await executor.executeRemoteDeletes(batch);
        }
      } catch (error) { report.failures.push({ phase: 'reconcile', attempt, error: String(error) }); save(); }
    }
    throw Error('Benchmark did not converge within eight reconciliation passes');
  });
  await measure('convergence', async () => {
    const read = async fn => { let error; for (let attempt = 0; attempt < 4; attempt++) try { return await fn(); } catch (e) { error = e; report.failures.push({ phase: 'convergence', attempt, error: String(e) }); } throw error; };
    report.ordinaryRemaining = (await read(() => client.listObjects())).length;
    report.tombstones = (await read(() => client.listTombstones())).length;
    report.versionObjects = (await read(() => port.list('.mineral/versions/'))).length;
    report.pendingTasks = (await read(() => port.list('.mineral/delete-tasks/'))).length;
  });
  report.convergenceMs = Math.round(performance.now() - convergenceStart); save();
  report.initialUnsuccessful = results.filter(r => r.status !== 'applied').length;
  if (report.ordinaryRemaining || report.pendingTasks) throw Error('Deletion incomplete');
} catch (error) { report.failure = String(error); save(); throw error; } finally {
  // Includes orphaned test backup bodies from deliberately interrupted/failed writes.
  // Production recovery cleanup keeps its stronger manifest/body and confirmation checks.
  report.cleanup = await cleanupDeleteBenchmark(client, settings.remotePrefix);
  report.remaining = report.cleanup.remaining; save();
}
console.log(JSON.stringify(report));
