import { describe, expect, it } from "vitest";
import { RemoteHttpError, RemoteObjectChangedError } from "../remote/errors";
import { SafeExecutor } from "./executor";
import type { R2Client } from "../remote/r2-client";
import type { StateStore } from "../state/sync-state";
import type { PreviousEntry, SyncOperation } from "./types";

const identity = { endpoint: "https://r2.example", bucket: "test", remotePrefix: "sync/" };
const bytes = (values: number[]) => new Uint8Array(values).buffer;
const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");

/** Mirrors the real Vault: createBinary does not create parent folders, createFolder is not recursive. */
function vault(contents: Record<string, number[]>, mtime = 10) {
  const files = new Map(Object.entries(contents).map(([key, value]) => [key, { bytes: bytes(value), mtime }]));
  const folders = new Set<string>();
  for (const key of files.keys()) { const parent = parentOf(key); if (parent) folders.add(parent); }
  const getFileByPath = (key: string) => files.has(key) ? ({ path: key } as never) : null;
  return {
    getFileByPath,
    getAbstractFileByPath: (key: string) => (files.has(key) || folders.has(key) ? ({ path: key } as never) : null),
    createFolder: async (key: string) => {
      if (folders.has(key) || files.has(key)) throw new Error(`already exists: ${key}`);
      const parent = parentOf(key);
      if (parent && !folders.has(parent)) throw new Error(`ENOENT: ${key}`);
      folders.add(key);
      return { path: key };
    },
    adapter: { stat: async (key: string) => { const value = files.get(key); return value ? { size: value.bytes.byteLength, mtime: value.mtime } : null; } },
    readBinary: async (file: { path: string }) => files.get(file.path)!.bytes,
    createBinary: async (key: string, value: ArrayBuffer) => {
      if (files.has(key)) throw new Error("exists");
      const parent = parentOf(key);
      if (parent && !folders.has(parent)) throw new Error(`ENOENT: no such file or directory, open '${key}'`);
      files.set(key, { bytes: value, mtime: 20 });
      return { path: key };
    },
    modifyBinary: async (file: { path: string }, value: ArrayBuffer) => { files.set(file.path, { bytes: value, mtime: 20 }); },
    files,
    folders,
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
  it("classifies a received auth failure as failed instead of an ambiguous write", async () => {
    const saved = state();
    const failing = remote({ putObject: async () => { throw new RemoteHttpError("PutObject", 403); } });
    await expect(new SafeExecutor(vault({ "a.bin": [1, 2, 3] }) as never, failing, saved, identity, "[]").execute(upload())).resolves.toEqual({ status: "failed", key: "a.bin", error: "R2 PutObject failed with HTTP 403" });
    expect(saved.entries).toHaveLength(0);
  });
  it("keeps a 5xx write response fail-safe as unresolved", async () => {
    const saved = state();
    const failing = remote({ putObject: async () => { throw new RemoteHttpError("PutObject", 503); } });
    await expect(new SafeExecutor(vault({ "a.bin": [1, 2, 3] }) as never, failing, saved, identity, "[]").execute(upload())).resolves.toEqual({ status: "unresolved", key: "a.bin", reason: "ambiguous-put" });
    expect(saved.entries).toHaveLength(0);
  });
  it("hard-blocks both deletion operations", async () => {
    const executor = new SafeExecutor(vault({}) as never, remote(), state(), identity, "[]");
    await expect(executor.execute({ type: "delete-local", key: "a", reason: "test" })).resolves.toMatchObject({ status: "blocked" });
    await expect(executor.execute({ type: "delete-remote", key: "a", reason: "test" })).resolves.toMatchObject({ status: "blocked" });
  });
  it("creates the missing parent folders before writing a nested download", async () => {
    const local = vault({}), saved = state();
    const nested: Extract<SyncOperation, { type: "download" }> = { type: "download", key: "a/b/c/note.md", reason: "test", expectedLocal: { kind: "absent" }, expectedRemote: { key: "a/b/c/note.md", size: 2, etag: "old", lastModified: 1 } };

    await expect(new SafeExecutor(local as never, remote(), saved, identity, "[]").execute(nested)).resolves.toEqual({ status: "applied", key: "a/b/c/note.md" });
    expect([...local.folders].sort()).toEqual(["a", "a/b", "a/b/c"]);
    expect(new Uint8Array(local.files.get("a/b/c/note.md")!.bytes)).toEqual(new Uint8Array([7, 8]));
    expect(saved.entries).toHaveLength(1);
  });
  it("fails a nested download when a file occupies a parent path, without touching it", async () => {
    const local = vault({ "a/b": [9, 9] }), saved = state();
    const nested: Extract<SyncOperation, { type: "download" }> = { type: "download", key: "a/b/note.md", reason: "test", expectedLocal: { kind: "absent" }, expectedRemote: { key: "a/b/note.md", size: 2, etag: "old", lastModified: 1 } };

    await expect(new SafeExecutor(local as never, remote(), saved, identity, "[]").execute(nested)).resolves.toMatchObject({ status: "failed", reason: "parent-path-is-file" });
    expect(new Uint8Array(local.files.get("a/b")!.bytes)).toEqual(new Uint8Array([9, 9]));
    expect(local.files.has("a/b/note.md")).toBe(false);
    expect(saved.entries).toHaveLength(0);
  });
  it("fails a download whose target path is occupied by a folder", async () => {
    const local = vault({ "a/other.md": [1] }), saved = state();
    const target: Extract<SyncOperation, { type: "download" }> = { type: "download", key: "a", reason: "test", expectedLocal: { kind: "absent" }, expectedRemote: { key: "a", size: 2, etag: "old", lastModified: 1 } };

    await expect(new SafeExecutor(local as never, remote(), saved, identity, "[]").execute(target)).resolves.toMatchObject({ status: "failed", reason: "target-path-is-folder" });
    expect(saved.entries).toHaveLength(0);
  });
  it("does not create folders when the remote read fails first", async () => {
    const local = vault({}), saved = state();
    const nested: Extract<SyncOperation, { type: "download" }> = { type: "download", key: "a/b/note.md", reason: "test", expectedLocal: { kind: "absent" }, expectedRemote: { key: "a/b/note.md", size: 2, etag: "old", lastModified: 1 } };
    const failing = remote({ getObject: async () => { throw new RemoteHttpError("GetObject", 503); } });

    await expect(new SafeExecutor(local as never, failing, saved, identity, "[]").execute(nested)).resolves.toMatchObject({ status: "failed" });
    expect([...local.folders]).toEqual([]);
    expect(saved.entries).toHaveLength(0);
  });
});
