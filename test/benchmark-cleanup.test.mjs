import { describe, expect, it } from 'vitest';
import { cleanupDeleteBenchmark } from '../scripts/cleanup-delete-benchmark.mjs';
const prefix = '.mineral/benchmarks/bulk-delete/12345678-1234-1234-1234-123456789012/';
function fixture() {
  const objects = new Map([['folder/note-0.md', { key: 'folder/note-0.md', etag: 'old' }]]), calls = [];
  const port = { list: async () => [], head: async (key, etag) => { calls.push(['head', key, etag]); const o = objects.get(key); if (o && etag && o.etag !== etag) throw Error('changed'); return o ?? null; }, remove: async key => { calls.push(['remove', key]); objects.delete(key); } };
  const client = { config: { remotePrefix: prefix }, recoveryPort: () => port, listObjects: async () => [...objects.values()] };
  return { client, port, objects, calls };
}
describe('isolated benchmark teardown', () => {
  it('refuses production clients and unrecorded object shapes', async () => {
    const f = fixture(); f.client.config.remotePrefix = '';
    await expect(cleanupDeleteBenchmark(f.client, prefix)).rejects.toThrow('not scoped');
    f.client.config.remotePrefix = prefix; f.objects.set('user-note.md', { key: 'user-note.md', etag: 'e' });
    await expect(cleanupDeleteBenchmark(f.client, prefix)).rejects.toThrow('Unexpected object');
    expect(f.calls).toEqual([]);
  });
  it('reconciles a lost response before retrying, with a fresh ETag check', async () => {
    const f = fixture(); let deletes = 0;
    f.port.remove = async key => { deletes++; f.objects.delete(key); throw Error('lost response'); };
    expect(await cleanupDeleteBenchmark(f.client, prefix)).toEqual({ removed: 1, remaining: 0 });
    expect(deletes).toBe(1);
  });
  it('stops if a surviving object changed after the attempted DELETE', async () => {
    const f = fixture(); let deletes = 0;
    f.port.remove = async key => { deletes++; f.objects.set(key, { key, etag: 'new' }); throw Error('unknown'); };
    await expect(cleanupDeleteBenchmark(f.client, prefix)).rejects.toThrow('changed during cleanup');
    expect(deletes).toBe(1);
  });
});
