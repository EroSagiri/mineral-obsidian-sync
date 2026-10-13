import { describe, expect, it } from "vitest";
import { RecoveryStore, encodeManifest, parseManifest, recoverySelection, type RecoveryEntry } from "@mineral/sync-core/recovery";
import { encodeTombstone, tombstoneKey, TOMBSTONE_NAMESPACE } from "@mineral/sync-core/tombstones";
import { LEGACY_TOMBSTONE_NAMESPACE } from "@mineral/sync-core/storage";
import { RecoveryMemory } from "../../test/recovery-memory";
const bytes = new TextEncoder().encode("原始 Markdown\n");
async function setup() {
  const port = new RecoveryMemory(); const source = await port.put("note.md", bytes, null, { owner: "mineral" }, "text/markdown", { "cache-control": "private" });
  const store = new RecoveryStore(port, "identity");
  return { port, source, store };
}
const versions = (entries: RecoveryEntry[]) => entries.filter(e => e.kind === "version");
describe("direct R2 recovery, gateway-independent", () => {
  it("backs up TOML, preserves binary bytes and original metadata", async () => {
    const { store } = await setup(); const e = await store.backup("note.md", "e1");
    expect(e.key.endsWith("/manifest.toml")).toBe(true);
    expect(parseManifest(encodeManifest(e.manifest!))).toEqual(e.manifest);
    expect(await store.preview(recoverySelection(e))).toEqual(bytes);
    expect(e.manifest!.original_metadata_json).toContain("mineral");
    expect(e.manifest!.original_http_metadata_json).toContain("private");
  });
  it("requires explicit confirmation, then backs up before tombstone before real DELETE and 404", async () => {
    const { store, port } = await setup();
    await expect(store.deleteFile("note.md", "e1", false)).rejects.toThrow("confirmation");
    const result = await store.deleteFile("note.md", "e1", true);
    expect(result.state).toBe("deleted"); expect(await port.head("note.md")).toBeNull();
    const writes = port.calls.filter(c => c.startsWith("PUT") || c.startsWith("DELETE"));
    expect(writes[1]).toContain("/content/note.md"); expect(writes[2]).toContain("manifest.toml"); expect(writes[3]).toContain("tombstones"); expect(writes[4]).toBe("DELETE note.md");
    expect(versions(await store.list())[0].manifest!.anomaly).toContain("delete-window-unverifiable");
  });
  for (const stage of ["/content/", "manifest.toml", "tombstones/"]) it(`does not DELETE the source when ${stage} fails`, async () => {
    const { store, port } = await setup(); port.failPut = stage;
    await expect(store.deleteFile("note.md", "e1", true)).rejects.toThrow();
    expect(await port.head("note.md")).not.toBeNull(); expect(port.calls).not.toContain("DELETE note.md");
  });
  it("keeps unknown DELETE pending, then confirms absence on retry", async () => {
    const { store, port } = await setup(); port.unknownDelete = true;
    expect((await store.deleteFile("note.md", "e1", true)).state).toBe("delete-pending");
    expect(versions(await store.list())[0].state).toBe("delete-pending");
    port.unknownDelete = false; await store.retryPending();
    expect(versions(await store.list())[0].state).toBe("deleted");
  });
  it("retains failed DELETE bytes and tombstone and safely retries", async () => {
    const { store, port } = await setup(); port.failDelete = true;
    expect((await store.deleteFile("note.md", "e1", true)).state).toBe("delete-pending");
    expect(await port.head("note.md")).not.toBeNull(); expect((await store.list()).some(e => e.kind === "tombstone")).toBe(true);
    port.failDelete = false; await store.retryPending(); expect(await port.head("note.md")).toBeNull();
  });
  it("records the accepted HEAD/recreation/DELETE race and keeps old bytes recoverable", async () => {
    const { store, port } = await setup(); port.recreateAfterHead = true;
    expect((await store.deleteFile("note.md", "e1", true)).state).toBe("deleted");
    expect(await port.head("note.md")).toBeNull();
    const e = versions(await store.list())[0]; expect(e.manifest!.anomaly).toContain("delete-window");
    await store.execute({ identity: "identity", confirmed: true, action: "restore", selection: recoverySelection(e), target: "restored.md", expectedTargetETag: null });
    expect(port.objects.get("restored.md")!.bytes).toEqual(bytes);
  });
  it("does not retry against a re-created ETag", async () => {
    const { store, port } = await setup(); port.failDelete = true; await store.deleteFile("note.md", "e1", true); port.failDelete = false;
    await port.put("note.md", new TextEncoder().encode("new"), "e1");
    await store.retryPending(); expect(new TextDecoder().decode(port.objects.get("note.md")!.bytes)).toBe("new");
    expect(versions(await store.list())[0].state).toBe("anomaly");
  });
  it("restores with conditional create, refuses same-name conflict and stale identity", async () => {
    const { store, port } = await setup(); const e = await store.backup("note.md", "e1");
    const intent = { identity: "identity", confirmed: true as const, action: "restore" as const, selection: recoverySelection(e), target: "note.md", expectedTargetETag: null };
    await expect(store.execute(intent)).rejects.toThrow("target changed");
    await expect(store.execute({ ...intent, identity: "different" })).rejects.toThrow("identity");
    await store.execute({ ...intent, expectedTargetETag: "e1" }); expect(versions(await store.list()).length).toBe(2);
    expect(port.objects.get("note.md")!.object.metadata.owner).toBe("mineral");
  });
  it("single, batch and empty-center cleanup physically remove groups, never ordinary files", async () => {
    const { store, port } = await setup(); const a = await store.backup("note.md", "e1"); const b = await store.backup("note.md", "e1");
    await store.execute({ identity: "identity", confirmed: true, action: "clean", selections: [recoverySelection(a)] });
    expect(versions(await store.list()).length).toBe(1);
    await store.execute({ identity: "identity", confirmed: true, action: "clean", selections: [recoverySelection(b)] });
    expect(await store.list()).toEqual([]); expect(await port.head("note.md")).not.toBeNull();
  });
  it("refuses damaged manifest, changed ETag, missing body and namespace injection before deletion", async () => {
    for (const damage of ["manifest", "body", "etag", "namespace"]) {
      const { store, port } = await setup(); const e = await store.backup("note.md", "e1"); const s = recoverySelection(e);
      if (damage === "manifest") port.objects.get(e.key)!.bytes = new TextEncoder().encode('path = "../escape"');
      if (damage === "body") port.objects.delete(e.key.replace("manifest.toml", "content/note.md"));
      if (damage === "etag") s.etag = "different";
      if (damage === "namespace") s.key = "note.md";
      await expect(store.execute({ identity: "identity", confirmed: true, action: "clean", selections: [s] })).rejects.toThrow();
      expect(port.calls.filter(c => c.startsWith("DELETE"))).toEqual([]);
    }
  });
  it("reads legacy tombstones only; cleans current tombstone without touching re-created ordinary file", async () => {
    const { store, port } = await setup(); const t = { protocol: 1 as const, path: "note.md", deletedRemoteETag: "old", createdAt: "2020-01-01T00:00:00Z" };
    const key = (await tombstoneKey(t.path, t.deletedRemoteETag))!;
    await port.put(key, encodeTombstone(t), null); await port.put(key.replace(TOMBSTONE_NAMESPACE, LEGACY_TOMBSTONE_NAMESPACE), encodeTombstone(t), null);
    const list = await store.list(); const legacy = list.find(e => e.state === "legacy-read-only")!;
    await expect(store.execute({ identity: "identity", confirmed: true, action: "clean", selections: [recoverySelection(legacy)] })).rejects.toThrow("legacy");
    const current = list.find(e => e.state === "tombstone")!;
    await store.execute({ identity: "identity", confirmed: true, action: "clean", selections: [recoverySelection(current)] });
    expect(await port.head("note.md")).not.toBeNull();
  });
  it("rejects duplicate TOML fields and invalid size", async () => {
    const { store } = await setup(); const e = await store.backup("note.md", "e1"); const text = new TextDecoder().decode(encodeManifest(e.manifest!));
    expect(() => parseManifest(new TextEncoder().encode(text + 'path = "other.md"'))).toThrow();
    expect(() => parseManifest(new TextEncoder().encode(text.replace(/size = \d+/, "size = -1")))).toThrow();
  });
  it("verified legacy migration copies TOML/content and retires only the old recovery object", async () => {
    const { store, port } = await setup();
    const key = ".mineral/versions/legacy/note.md";
    await port.put(key, bytes, null, { sourceKey: "note.md", mineralOriginalMetadata: JSON.stringify({ owner: "legacy" }) });
    const legacy = (await store.list()).find(e => e.kind === "legacy-version")!;
    expect(await store.preview(recoverySelection(legacy))).toEqual(bytes);
    await store.execute({ identity: "identity", confirmed: true, action: "migrate", selection: recoverySelection(legacy) });
    expect(await port.head(key)).toBeNull();
    const migrated = versions(await store.list())[0]; expect(migrated.reason).toBe("migration");
    expect(await store.preview(recoverySelection(migrated))).toEqual(bytes); expect(await port.head("note.md")).not.toBeNull();
  });
  it("a cleanup interrupted after body removal resumes only with its persisted authorized group", async () => {
    const { store, port } = await setup(); const entry = await store.backup("note.md", "e1");
    port.unknownDelete = true;
    await expect(store.execute({ identity: "identity", confirmed: true, action: "clean", selections: [recoverySelection(entry)] })).rejects.toThrow();
    const pending = (await store.list()).find(e => e.kind === "version")!;
    expect(pending.state).toBe("cleanup-pending");
    port.unknownDelete = false;
    await store.execute({ identity: "identity", confirmed: true, action: "clean", selections: [recoverySelection(pending)] });
    expect(await store.list()).toEqual([]); expect(await port.head("note.md")).not.toBeNull();
  });

  it("archives a pre-0.0.3 deleted body into TOML without deleting its original or legacy tombstone", async () => {
    const { store, port } = await setup(); const t = { protocol: 1 as const, path: "note.md", deletedRemoteETag: "e1", createdAt: "2020-01-01T00:00:00Z" };
    const key = (await tombstoneKey(t.path, t.deletedRemoteETag))!.replace(TOMBSTONE_NAMESPACE, LEGACY_TOMBSTONE_NAMESPACE);
    await port.put(key, encodeTombstone(t), null);
    const old = (await store.list()).find(e => e.state === "legacy-read-only")!;
    expect(await store.preview(recoverySelection(old))).toEqual(bytes);
    await store.execute({ identity: "identity", confirmed: true, action: "migrate", selection: recoverySelection(old) });
    expect(versions(await store.list())[0].reason).toBe("migration"); expect(await port.head(key)).not.toBeNull(); expect(await port.head("note.md")).not.toBeNull();
  });
  it("refuses to retire a pending deletion's tombstone and resurrect its surviving old body", async () => {
    const { store, port } = await setup(); port.failDelete = true; await store.deleteFile("note.md", "e1", true); port.failDelete = false;
    const tombstone = (await store.list()).find(e => e.kind === "tombstone")!;
    await expect(store.execute({ identity: "identity", confirmed: true, action: "clean", selections: [recoverySelection(tombstone)] })).rejects.toThrow("删除待确认");
    expect(await port.head(tombstone.key)).not.toBeNull();
  });

  it("keeps Unicode original paths in TOML while making S3 compatibility headers ASCII-safe", async () => {
    const { store, port } = await setup(); const path = "附件/中文.md"; const source = await port.put(path, bytes, null);
    const e = await store.backup(path, source.etag); expect(e.manifest!.path).toBe(path);
    const copy = port.objects.get(e.key.replace("manifest.toml", `content/${path}`))!;
    expect(copy.object.metadata.mineralSourceKeyEncoding).toBe("uri");
    expect(decodeURIComponent(copy.object.metadata.sourceKey)).toBe(path);
    expect(Object.values(copy.object.metadata).every(v => /^[\x00-\x7f]*$/.test(v))).toBe(true);
  });

  it("restoring a pending deletion retires that intent before its tombstone is removed", async () => {
    const { store, port } = await setup(); port.failDelete = true; await store.deleteFile("note.md", "e1", true); port.failDelete = false;
    const entry = versions(await store.list())[0];
    await store.execute({ identity: "identity", confirmed: true, action: "restore", selection: recoverySelection(entry), target: "note.md", expectedTargetETag: "e1" });
    await store.retryPending(); expect(await port.head("note.md")).not.toBeNull();
    expect(versions(await store.list()).some(e => e.manifest!.anomaly.startsWith("restored-by-user"))).toBe(true);
    expect((await store.list()).some(e => e.kind === "tombstone")).toBe(false);
  });

});
