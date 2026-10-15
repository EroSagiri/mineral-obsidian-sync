/** Teardown capability restricted to UUID prefixes minted by the deletion benchmarks. */
export async function cleanupDeleteBenchmark(client, prefix) {
  if (!/^(?:mineral-bulk-benchmark|\.mineral\/benchmarks\/(?:bulk-delete|live-windows|live-android))\/[0-9a-f-]{36}\/$/.test(prefix)) throw Error('Not an owned deletion benchmark prefix');
  if (client.config?.remotePrefix !== prefix) throw Error('Cleanup client is not scoped to its recorded fixture prefix');
  const port = client.recoveryPort();
  const read = async fn => { let error; for (let attempt = 0; attempt < 4; attempt++) try { return await fn(); } catch (e) { error = e; } throw error; };
  // A distinct test executor accepts only an explicit, ETag-bound object inventory. No prefix DELETE.
  class FixtureSafeExecutor {
    async remove(object) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await read(() => port.head(object.key));
        if (!current) return;
        if (current.etag !== object.etag) throw Error('Fixture changed during cleanup: ' + object.key);
        await read(() => port.head(object.key, object.etag));
        try { await port.remove(object.key); } catch { /* Reconcile unknown before any retry. */ }
        if (!await read(() => port.head(object.key))) return;
      }
      throw Error('Fixture removal remains pending: ' + object.key);
    }
  }
  const ordinary = await read(() => client.listObjects());
  const internal = await read(() => port.list('.mineral/'));
  const objects = [...ordinary, ...internal];
  if (objects.some(o => !o.etag || !/^(?:folder\/note-\d+\.md|mineral-live-[0-9a-f-]{36}\/note-\d+\.md|\.mineral\/(?:versions\/[A-Za-z0-9_-]+\/(?:manifest\.toml|content\/folder\/note-\d+\.md)|tombstones\/[A-Za-z0-9_-]+\.json|delete-tasks\/[a-f0-9]+\.json))$/.test(o.key))) throw Error('Unexpected object in owned fixture inventory');
  const executor = new FixtureSafeExecutor();
  for (let start = 0; start < objects.length; start += 4) await Promise.all(objects.slice(start, start + 4).map(object => executor.remove(object)));
  return { removed: objects.length, remaining: (await read(() => client.listObjects())).length + (await read(() => port.list('.mineral/'))).length };
}
