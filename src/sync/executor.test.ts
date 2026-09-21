import { describe, expect, it } from "vitest";
import { RemoteObjectChangedError } from "../remote/errors";
import { SafeExecutor } from "./executor";
import type { R2Client } from "../remote/r2-client";
import type { StateStore } from "../state/sync-state";
import type { PreviousEntry, SyncOperation } from "./types";

const identity = { endpoint: "https://r2.example", bucket: "test", remotePrefix: "sync/" };
const bytes = (values: number[]) => new Uint8Array(values).buffer;
function vault(contents: Record<string, number[]>, mtime = 10) {
  const files = new Map(Object.entries(contents).map(([key, value]) => [key, { bytes: bytes(value), mtime }]));
  const getFileByPath = (key: string) => files.has(key) ? ({ path: key } as never) : null;
  return {
    getFileByPath,
    adapter: { stat: async (key: string) => { const value = files.get(key); return value ? { size: value.bytes.byteLength, mtime: value.mtime } : null; } },
    readBinary: async (file: { path: string }) => files.get(file.path)!.bytes,
    createBinary: async (key: string, value: ArrayBuffer) => { if (files.has(key)) throw new Error("exists"); files.set(key, { bytes: value, mtime: 20 }); return { path: key }; },
    modifyBinary: async (file: { path: string }, value: ArrayBuffer) => { files.set(file.path, { bytes: value, mtime: 20 }); },
    files,
  };
}
function state(fails = false): StateStore & { entries: PreviousEntry[] } {
  const entries: PreviousEntry[] = [];
  return { entries, loadAll: async () => new Map(), saveAll: async () => {}, saveVerified: async () => {}, put: async (entry) => { if (fails) throw new Error("IDB unavailable"); entries.push(entry); } };
}
function remote(overrides: Partial<R2Client> = {}): R2Client {
  return { listObjects: async () => [], headObject: async () => ({ key: "", size: 0, lastModified: 0 }), getObject: async () => bytes([7, 8]), putObject: async (key) => ({ key, size: 3, etag: "new", lastModified: 22 }), ...overrides };
}
const upload = (): Extract<SyncOperation, { type: "upload" }> => ({ type: "upload", key: "a.bin", reason: "test", expectedLocal: { key: "a.bin", size: 3, mtime: 10 }, expectedRemote: { kind: "absent" } });
const download = (): Extract<SyncOperation, { type: "download" }> => ({ type: "download", key: "a.bin", reason: "test", expectedLocal: { kind: "absent" }, expectedRemote: { key: "a.bin", size: 2, etag: "old", lastModified: 1 } });

describe("SafeExecutor", () => {
  it("uses conditional create and commits exactly the successful key", async () => {
    const local = vault({ "a.bin": [1, 2, 3] }), saved = state(); let condition: unknown;
    const result = await new SafeExecutor(local as never, remote({ putObject: async (key, _body, options) => { condition = options; return { key, size: 3, etag: "new", lastModified: 22 }; } }), saved, identity, "[]").execute(upload());
    expect(result).toEqual({ status: "applied", key: "a.bin" }); expect(condition).toEqual({ ifNoneMatch: "*" }); expect(saved.entries).toHaveLength(1);
  });
  it("preserves state when a conditional update is stale", async () => {
    const op = { ...upload(), expectedRemote: { kind: "etag" as const, value: "old" } }, saved = state();
    await expect(new SafeExecutor(vault({ "a.bin": [1, 2, 3] }) as never, remote({ putObject: async () => { throw new RemoteObjectChangedError(); } }), saved, identity, "[]").execute(op)).resolves.toMatchObject({ status: "stale", reason: "remote-changed" });
    expect(saved.entries).toHaveLength(0);
  });
  it("will not overwrite a locally-created download target", async () => {
    const local = vault({ "a.bin": [9] }), saved = state();
    await expect(new SafeExecutor(local as never, remote(), saved, identity, "[]").execute(download())).resolves.toMatchObject({ status: "stale", reason: "local-changed" });
    expect([...local.files.values()][0].bytes).toEqual(bytes([9])); expect(saved.entries).toHaveLength(0);
  });
  it("writes binary download bytes and commits only after the Vault write", async () => {
    const local = vault({}), saved = state();
    await expect(new SafeExecutor(local as never, remote(), saved, identity, "[]").execute(download())).resolves.toEqual({ status: "applied", key: "a.bin" });
    expect(new Uint8Array(local.files.get("a.bin")!.bytes)).toEqual(new Uint8Array([7, 8])); expect(saved.entries).toHaveLength(1);
  });
  it("reports a successful transfer with failed state persistence as unresolved", async () => {
    await expect(new SafeExecutor(vault({ "a.bin": [1, 2, 3] }) as never, remote(), state(true), identity, "[]").execute(upload())).resolves.toEqual({ status: "unresolved", key: "a.bin", reason: "state-commit-failed" });
  });
  it("hard-blocks both deletion operations", async () => {
    const executor = new SafeExecutor(vault({}) as never, remote(), state(), identity, "[]");
    await expect(executor.execute({ type: "delete-local", key: "a", reason: "test" })).resolves.toMatchObject({ status: "blocked" });
    await expect(executor.execute({ type: "delete-remote", key: "a", reason: "test" })).resolves.toMatchObject({ status: "blocked" });
  });
});
