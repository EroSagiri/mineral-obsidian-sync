import { describe, expect, it } from "vitest";
import { deviceHotClientId, migrateHotClientIdentity } from "./device-identity";
import { MemoryHotStateStore } from "./store";

describe("installation hot identity", () => {
  it("stays stable across reloads and differs between device-local stores", () => {
    const device = () => {
      let value: unknown = null;
      return { read: () => value, write: (id: string) => { value = id; } };
    };
    const desktop = device(), android = device();
    const first = deviceHotClientId(desktop);
    expect(deviceHotClientId(desktop)).toBe(first);
    expect(deviceHotClientId(android)).not.toBe(first);
  });

  it("preserves unacknowledged updates, operation identity and recovery state during migration", async () => {
    const store = new MemoryHotStateStore();
    const session = { canonicalPath: "未命名.md", documentId: "document", epoch: 1, clientId: "copied-id", status: "disconnected" as const, lastAcceptedRevision: 3, lastCheckpointedRevision: 2, pendingSave: true, requestedRevision: 3, updatedAt: 1 };
    const entry = { key: "document:1:operation", canonicalPath: session.canonicalPath, documentId: "document", epoch: 1, clientId: "copied-id", clientOperationId: "operation", update: "unchanged-yjs-update", createdAt: 1, attempts: 2 };
    await store.putSession(session);
    await store.putOutbox(entry);
    await migrateHotClientIdentity(store, "android-id");
    await migrateHotClientIdentity(store, "android-id");
    expect(await store.loadSessions()).toEqual([{ ...session, clientId: "android-id" }]);
    expect(await store.loadOutbox()).toEqual([{ ...entry, clientId: "android-id" }]);
  });
});
