import type { RecoveryObject, RecoveryPort } from "@mineral/sync-core/recovery";
export class RecoveryMemory implements RecoveryPort {
  readonly objects = new Map<string, { object: RecoveryObject; bytes: Uint8Array }>();
  readonly calls: string[] = [];
  sequence = 0;
  failPut = "";
  failDelete = false;
  unknownDelete = false;
  recreateAfterHead = false;
  constructor(private readonly clock = () => new Date("2026-10-13T00:00:00.000Z")) {}
  async list(prefix: string) { return [...this.objects.values()].map(v => v.object).filter(v => v.key.startsWith(prefix)); }
  async head(key: string, etag?: string) {
    this.calls.push(`HEAD ${key}`);
    const o = this.objects.get(key)?.object ?? null;
    if (o && etag && etag !== o.etag) throw new Error("ETag changed");
    if (this.recreateAfterHead && key === "note.md" && etag) {
      const checks = this.calls.filter(c => c === "HEAD note.md").length;
      if (checks === 2) await this.put(key, new TextEncoder().encode("new concurrent content"), o!.etag);
    }
    return o;
  }
  async read(key: string, etag: string) {
    this.calls.push(`GET ${key}`); const o = this.objects.get(key);
    if (!o || o.object.etag !== etag) throw new Error("ETag changed or missing");
    return { object: o.object, bytes: o.bytes.slice() };
  }
  async put(key: string, bytes: Uint8Array, expected: string | null, metadata: Record<string, string> = {}, contentType = "text/markdown", httpMetadata: Record<string, string> = {}) {
    this.calls.push(`PUT ${key}`);
    if (key.includes(this.failPut) && this.failPut) throw new Error("injected PUT failure");
    if ((this.objects.get(key)?.object.etag ?? null) !== expected) throw new Error("conditional PUT failed");
    const object = { key, etag: `e${++this.sequence}`, size: bytes.byteLength, modified: this.clock().toISOString(), contentType, metadata, httpMetadata };
    this.objects.set(key, { object, bytes: bytes.slice() }); return object;
  }
  async remove(key: string) {
    this.calls.push(`DELETE ${key}`);
    if (this.failDelete) throw new Error("injected DELETE failure");
    this.objects.delete(key);
    if (this.unknownDelete) throw new Error("connection lost after DELETE landed");
  }
}
