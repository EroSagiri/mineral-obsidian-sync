import { describe, expect, it, vi } from "vitest";
import type { Vault } from "obsidian";
import { RecoveryStore, recoverySelection } from "@mineral/sync-core/recovery";
import { SafeExecutor } from "./executor";
import type { StateStore } from "../state/sync-state";
import type { R2Client } from "../remote/r2-client";
import { RecoveryMemory } from "../../test/recovery-memory";
const identity = { endpoint: "https://r2.example", bucket: "bucket", remotePrefix: "" };
async function setup(confirmed = true, offline = false) {
  const port = new RecoveryMemory(); await port.put("note.md", new TextEncoder().encode("old"), null);
  const state: StateStore = { loadAll: async () => new Map(), saveAll: async () => {}, saveVerified: async () => {}, put: async () => {}, delete: vi.fn(async () => {}) };
  const client: R2Client = { recoveryPort: () => port, listObjects: async () => [], headObject: async key => { const o = await port.head(key); if (!o) throw new Error("404"); return { key, size: o.size, etag: o.etag, lastModified: Date.parse(o.modified) }; }, getObject: async (key, options) => (await port.read(key, options!.ifMatch!)).bytes.slice().buffer, putObject: async (key, body, options) => port.put(key, new Uint8Array(body), options.ifMatch ?? null) };
  const changed = vi.fn(async () => { if (offline) throw new Error("gateway offline"); });
  const executor = new SafeExecutor({} as Vault, client, state, identity, "", undefined, undefined, undefined, { confirmDelete: async () => confirmed, changed });
  return { port, client, state, executor, changed, store: new RecoveryStore(port, JSON.stringify(identity)) };
}
describe("SafeExecutor owns recovery mutation ingress", () => {
  for (const deletionMode of ["backup", "direct"] as const) it(`runs ${deletionMode} batches offline and only prunes verified absence`, async () => {
    const { port, client, state } = await setup();
    const changed = vi.fn(async () => { throw Error("gateway offline"); });
    const executor = new SafeExecutor({} as Vault, client, state, identity, "", undefined, undefined, undefined, { deletionMode, defer: true, confirmDelete: async () => true, changed });
    const results = await executor.executeRemoteDeletes([{ type: "delete-remote", key: "note.md", expectedRemoteETag: "e1", reason: "local-deleted" }]);
    expect(results).toEqual([{ status: "applied", key: "note.md", physicalDeleted: true }]);
    expect(state.delete).toHaveBeenCalledWith("note.md");
    expect((await port.list(".mineral/versions/")).length).toBe(deletionMode === "backup" ? 2 : 0);
    await executor.flushRecoveryChanges(); expect(changed).toHaveBeenCalledTimes(1);
  });
  it("resumes direct tasks under a new backup-mode executor after reload", async () => {
    const { port, client, state } = await setup(); port.failDelete = true;
    (port as typeof port & { isPreconditionFailure(error: unknown): boolean }).isPreconditionFailure = error => String(error).includes("conditional PUT failed");
    const hooks = { deletionMode: "direct" as "direct" | "backup", confirmDelete: async () => true, changed: async () => {} };
    const executor = new SafeExecutor({} as Vault, client, state, identity, "", undefined, undefined, undefined, hooks);
    expect((await executor.execute({ type: "delete-remote", key: "note.md", expectedRemoteETag: "e1", reason: "local-deleted" })).status).toBe("partial");
    expect(state.delete).not.toHaveBeenCalled(); port.failDelete = false;
    await new SafeExecutor({} as Vault, client, state, identity, "", undefined, undefined, undefined, { ...hooks, deletionMode: "backup" }).retryRecoveryDeletes();
    expect(await port.head("note.md")).toBeNull(); expect(await port.list(".mineral/versions/")).toEqual([]);
  });
  it("coalesces a folder's notifications and completes with an offline gateway", async () => {
    const { port, client, state } = await setup();
    const changed = vi.fn(async () => { throw Error("offline"); });
    const executor = new SafeExecutor({} as Vault, client, state, identity, "", undefined, undefined, undefined, { defer: true, confirmDelete: async () => true, changed });
    const entries = await Promise.all(Array.from({ length: 8 }, (_, i) => port.put(`folder/${i}.md`, new TextEncoder().encode("body"), null)));
    const results = [];
    for (let i = 0; i < entries.length; i += 4) results.push(...await Promise.all(entries.slice(i, i + 4).map(o => executor.execute({ type: "delete-remote", key: o.key, expectedRemoteETag: o.etag, reason: "local-deleted" }))));
    expect(results.every(r => r.status === "applied")).toBe(true); expect(changed).not.toHaveBeenCalled();
    await executor.flushRecoveryChanges(); await executor.flushRecoveryChanges(); expect(changed).toHaveBeenCalledTimes(1);
  });
  it("requires confirmation for normal sync physical deletion", async () => {
    const { executor, port } = await setup(false);
    expect(await executor.execute({ type: "delete-remote", key: "note.md", reason: "local-deleted", expectedRemoteETag: "e1" })).toMatchObject({ status: "blocked", reason: "physical-delete-confirmation-required" });
    expect(await port.head("note.md")).not.toBeNull();
  });
  it("verifies real absence, prunes only then, and announces even with gateway offline", async () => {
    const { executor, port, state, changed } = await setup(true, true);
    expect(await executor.execute({ type: "delete-remote", key: "note.md", reason: "local-deleted", expectedRemoteETag: "e1" })).toMatchObject({ status: "applied", physicalDeleted: true });
    expect(await port.head("note.md")).toBeNull(); expect(state.delete).toHaveBeenCalledWith("note.md"); expect(changed).toHaveBeenCalled();
  });
  it("offline restore and cleanup still execute R2 intents and call optional notifier", async () => {
    const { executor, port, store, changed } = await setup(true, true);
    const entry = await store.backup("note.md", "e1");
    await executor.executeRecovery({ identity: store.identity, confirmed: true, action: "restore", selection: recoverySelection(entry), target: "new.md", expectedTargetETag: null });
    await executor.executeRecovery({ identity: store.identity, confirmed: true, action: "clean", selections: [recoverySelection(entry)] });
    expect(await port.head("new.md")).not.toBeNull(); expect(await store.list()).toEqual([]); expect(changed).toHaveBeenCalledTimes(2);
  });
  it("pending unknown DELETE retains baseline and subsequent scan retry finishes it", async () => {
    const { executor, port, store, state } = await setup(); port.unknownDelete = true;
    expect(await executor.execute({ type: "delete-remote", key: "note.md", reason: "local-deleted", expectedRemoteETag: "e1" })).toMatchObject({ status: "partial", reason: "physical-delete-pending" });
    expect(state.delete).not.toHaveBeenCalled(); port.unknownDelete = false; await executor.retryRecoveryDeletes();
    expect((await store.list()).find(e => e.kind === "version")!.state).toBe("deleted");
  });
});
