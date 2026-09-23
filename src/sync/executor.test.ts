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
  return { entries, loadAll: async () => new Map(), saveAll: async () => {}, saveVerified: async () => {}, put: async (entry) => { if (fails) throw new Error("IDB unavailable"); entries.push(entry); }, delete: async () => { if (fails) throw new Error("IDB unavailable"); } };
}
function remote(overrides: Partial<R2Client> = {}): R2Client {
  // Mirrors the real client: a write response yields only the size we sent and the server ETag.
  return { listObjects: async () => [], headObject: async () => ({ key: "", size: 0, lastModified: 0 }), getObject: async () => bytes([7, 8]), putObject: async () => ({ size: 3, etag: "new" }), ...overrides };
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
  it("catches up one newer local save using only the ETag returned by its own first PUT", async () => {
    const local = vault({ "a.bin": [1, 2, 3] }), saved = state();
    const writes: Array<{ body: number[]; options: unknown }> = [];
    const client = remote({ putObject: async (_key, body, options) => {
      writes.push({ body: [...new Uint8Array(body)], options });
      if (writes.length === 1) {
        // Simulate a second editor save while the first R2 PUT is in flight.
        local.files.set("a.bin", { bytes: bytes([4, 5, 6, 7]), mtime: 20 });
        return { size: 3, etag: "first" };
      }
      return { size: 4, etag: "latest" };
    } });

    await expect(new SafeExecutor(local as never, client, saved, identity, "[]").execute(upload())).resolves.toEqual({ status: "applied", key: "a.bin" });
    expect(writes).toEqual([{ body: [1, 2, 3], options: { ifNoneMatch: "*" } }, { body: [4, 5, 6, 7], options: { ifMatch: "first" } }]);
    // Two true facts, in order: the first PUT's own pair, then the catch-up's upgrade of it.
    expect(saved.entries).toMatchObject([
      { local: { size: 3, mtime: 10 }, remote: { etag: "first" } },
      { local: { size: 4, mtime: 20 }, remote: { etag: "latest" } },
    ]);
  });
  it("does not overwrite an intervening remote writer while catching up a local save", async () => {
    const local = vault({ "a.bin": [1, 2, 3] }), saved = state(); let calls = 0;
    const client = remote({ putObject: async () => {
      calls++;
      if (calls === 1) { local.files.set("a.bin", { bytes: bytes([4, 5, 6, 7]), mtime: 20 }); return { size: 3, etag: "first" }; }
      throw new RemoteObjectChangedError();
    } });
    await expect(new SafeExecutor(local as never, client, saved, identity, "[]").execute(upload())).resolves.toEqual({ status: "partial", key: "a.bin", reason: "remote-applied-local-changed" });
    // The refused catch-up changes nothing about the transfer that did land: its floor baseline is kept,
    // which is what stops the next plan from reading this device's own PUT as a remote concurrent edit.
    expect(saved.entries).toMatchObject([{ local: { size: 3, mtime: 10 }, remote: { etag: "first" } }]);
  });
  it("will not overwrite a locally-created download target", async () => {
    const local = vault({ "a.bin": [9] }), saved = state();
    await expect(new SafeExecutor(local as never, remote(), saved, identity, "[]").execute(download())).resolves.toMatchObject({ status: "stale", reason: "local-changed" });
    expect([...local.files.values()][0].bytes).toEqual(bytes([9])); expect(saved.entries).toHaveLength(0);
  });
  it("writes binary download bytes and commits only after the Vault write", async () => {
    const local = vault({}), saved = state();
    await expect(new SafeExecutor(local as never, remote(), saved, identity, "[]").execute(download())).resolves.toMatchObject({ status: "applied", key: "a.bin", localWrite: { key: "a.bin", size: 2, mtime: 20 } });
    expect(new Uint8Array(local.files.get("a.bin")!.bytes)).toEqual(new Uint8Array([7, 8])); expect(saved.entries).toHaveLength(1);
  });
  it("reports a successful transfer with failed state persistence as unresolved", async () => {
    await expect(new SafeExecutor(vault({ "a.bin": [1, 2, 3] }) as never, remote(), state(true), identity, "[]").execute(upload())).resolves.toEqual({ status: "unresolved", key: "a.bin", reason: "state-commit-failed" });
  });
  it("classifies a received auth failure as failed instead of an ambiguous write", async () => {
    const saved = state();
    const failing = remote({ putObject: async () => { throw new RemoteHttpError("PutObject", 403); } });
    await expect(new SafeExecutor(vault({ "a.bin": [1, 2, 3] }) as never, failing, saved, identity, "[]").execute(upload())).resolves.toEqual({ status: "failed", key: "a.bin", error: "R2 PutObject failed with HTTP 403", httpStatus: 403 });
    expect(saved.entries).toHaveLength(0);
  });
  it("keeps a 5xx write response fail-safe as unresolved", async () => {
    const saved = state();
    const failing = remote({ putObject: async () => { throw new RemoteHttpError("PutObject", 503); } });
    await expect(new SafeExecutor(vault({ "a.bin": [1, 2, 3] }) as never, failing, saved, identity, "[]").execute(upload())).resolves.toEqual({ status: "unresolved", key: "a.bin", reason: "ambiguous-put" });
    expect(saved.entries).toHaveLength(0);
  });
  it("reports a 2xx write that carries no ETag as unresolved, without committing a baseline", async () => {
    const saved = state();
    const failing = remote({ putObject: async () => { throw new Error("R2 PutObject returned no ETag"); } });
    await expect(new SafeExecutor(vault({ "a.bin": [1, 2, 3] }) as never, failing, saved, identity, "[]").execute(upload())).resolves.toEqual({ status: "unresolved", key: "a.bin", reason: "ambiguous-put" });
    expect(saved.entries).toHaveLength(0);
  });
  it("commits only what the write response established, without inventing a server timestamp", async () => {
    const saved = state();
    const result = await new SafeExecutor(vault({ "a.bin": [1, 2, 3] }) as never, remote(), saved, identity, "[]").execute(upload());
    expect(result).toEqual({ status: "applied", key: "a.bin" });
    expect(saved.entries[0]!.remote).toEqual({ size: 3, etag: "new" });
    expect(saved.entries[0]!.remote!.lastModified).toBeUndefined();
  });
  it("refuses a remote logical deletion that lacks an exact version", async () => {
    const executor = new SafeExecutor(vault({}) as never, remote(), state(), identity, "[]");
    await expect(executor.execute({ type: "delete-remote", key: "a", reason: "test" })).resolves.toEqual({ status: "blocked", key: "a", reason: "missing-remote-etag" });
  });
  it("creates an immutable tombstone only after proving the expected object version", async () => {
    const created: unknown[] = [], deleted: string[] = [];
    const saved: StateStore = { ...state(), delete: async (key) => { deleted.push(key); } };
    const client = remote({
      headObject: async (_key, options) => ({ key: "a", size: 3, etag: options?.ifMatch, lastModified: 1 }),
      putTombstone: async (record) => { created.push(record); return { tombstone: record }; },
    });
    const result = await new SafeExecutor(vault({}) as never, client, saved, identity, "[]").execute({ type: "delete-remote", key: "a", reason: "test", expectedRemoteETag: "A" });
    expect(result).toEqual({ status: "applied", key: "a" });
    expect(created).toMatchObject([{ path: "a", deletedRemoteETag: "A", protocol: 1 }]);
    expect(deleted).toEqual(["a"]);
  });
  it("does not retire a baseline when a tombstone PUT outcome is ambiguous", async () => {
    const deleted: string[] = [];
    const saved: StateStore = { ...state(), delete: async (key) => { deleted.push(key); } };
    const client = remote({ headObject: async () => ({ key: "a", size: 3, etag: "A", lastModified: 1 }), putTombstone: async () => { throw new RemoteHttpError("PutObject", 503); } });
    await expect(new SafeExecutor(vault({}) as never, client, saved, identity, "[]").execute({ type: "delete-remote", key: "a", reason: "test", expectedRemoteETag: "A" })).resolves.toEqual({ status: "unresolved", key: "a", reason: "ambiguous-put" });
    expect(deleted).toEqual([]);
  });
  it("logs the local deletion at the moment its tombstone landed", async () => {
    const logs: string[] = [];
    const client = remote({ headObject: async () => ({ key: "a", size: 3, etag: "A", lastModified: 1 }), putTombstone: async (record) => ({ tombstone: record }) });
    await new SafeExecutor(vault({}) as never, client, state(), identity, "[]", undefined, undefined, (message) => logs.push(message)).execute({ type: "delete-remote", key: "a", reason: "test", expectedRemoteETag: "A" });

    // Two facts, in the order they became true: the tombstone landed (the R2 half), and only then was the
    // baseline retired. Only the digest of the path is ever named.
    expect(logs.some((line) => /^local delete landed path-digest=[0-9a-f]{8} tombstone=written$/.test(line))).toBe(true);
    expect(logs.join("\n")).not.toContain("a ");
  });

  describe("delete-local (recovery-first)", () => {
    /** A Vault whose removal is observable, so the test can assert what was actually removed. */
    function trashable(initial: Record<string, number[]>) {
      const local = vault(initial);
      const trashed: string[] = [];
      let trashFails = false;
      let unlinkAttempted = false;
      const remover = { trash: async (file: { path: string }) => { if (trashFails) throw new Error("system trash is disabled"); trashed.push(file.path); local.files.delete(file.path); } };
      return { local, remover, trashed, setTrashFails: (value: boolean) => { trashFails = value; }, unlinkAttempted: () => unlinkAttempted };
    }
    const deleteLocal = (key: string, size: number, mtime: number): Extract<SyncOperation, { type: "delete-local" }> => ({ type: "delete-local", key, reason: "test", expectedLocal: { key, size, mtime } });

    it("trashes the file and retires the baseline when both sides become absent", async () => {
      const { local, remover, trashed } = trashable({ "a.bin": [1, 2, 3] });
      const saved = state(); saved.entries.push({ key: "a.bin", local: { size: 3, mtime: 10 }, remote: { size: 3, etag: "A" }, syncedAt: 1 });
      const result = await new SafeExecutor(local as never, remote(), saved, identity, "[]", remover).execute(deleteLocal("a.bin", 3, 10));
      expect(result).toEqual({ status: "applied", key: "a.bin" });
      expect(trashed).toEqual(["a.bin"]);
      expect(local.files.has("a.bin")).toBe(false);
    });

    it("never removes a file that changed after the scan recorded it", async () => {
      // The scan saw L1; the user then edited the file to L2. The destructive action must not happen.
      const { local, remover, trashed } = trashable({ "a.bin": [1, 2, 3] });
      // mtime 99 is what the vault reports now; the plan was built from mtime 10.
      local.files.set("a.bin", { bytes: bytes([1, 2, 3, 4]), mtime: 99 });
      const saved = state();
      const result = await new SafeExecutor(local as never, remote(), saved, identity, "[]", remover).execute(deleteLocal("a.bin", 3, 10));
      expect(result).toEqual({ status: "stale", key: "a.bin", reason: "local-changed" });
      expect(trashed).toEqual([]);
      expect(local.files.has("a.bin")).toBe(true);
      expect(saved.entries).toHaveLength(0);
    });

    it("treats an already-absent local file as a completed deletion and still retires the baseline", async () => {
      const { local, remover, trashed } = trashable({});
      const saved = state();
      const result = await new SafeExecutor(local as never, remote(), saved, identity, "[]", remover).execute(deleteLocal("a.bin", 3, 10));
      expect(result).toEqual({ status: "applied", key: "a.bin" });
      expect(trashed).toEqual([]);
    });

    it("fails safely, without unlinking, when no recovery path exists", async () => {
      const { local, remover, setTrashFails } = trashable({ "a.bin": [1, 2, 3] });
      setTrashFails(true);
      const saved = state();
      const result = await new SafeExecutor(local as never, remote(), saved, identity, "[]", remover).execute(deleteLocal("a.bin", 3, 10));
      expect(result).toMatchObject({ status: "failed", reason: "trash-unavailable" });
      // The file survives: there is no permanent-unlink fallback.
      expect(local.files.has("a.bin")).toBe(true);
      expect(saved.entries).toHaveLength(0);
    });

    it("reports a removal that raised and still took the file as partial, not as failed", async () => {
      // A call that throws cannot be described as a clean removal, and `failed` promises that nothing
      // needs recovering. The file is what decides: it is gone, so a side effect exists that no baseline
      // accounts for, and the cycle must not retire a remote generation on the strength of this result.
      const local = vault({ "a.bin": [1, 2, 3] });
      const remover = { trash: async (file: { path: string }) => { local.files.delete(file.path); throw new Error("trash reported a failure after removing the file"); } };
      const saved: StateStore = { ...state(), delete: async () => { throw new Error("store unavailable"); } };

      const result = await new SafeExecutor(local as never, remote(), saved, identity, "[]", remover).execute(deleteLocal("a.bin", 3, 10));

      expect(result).toMatchObject({ status: "partial", reason: "local-delete-landing-unknown" });
      expect(local.files.has("a.bin")).toBe(false);
    });

    it("logs a landed remote deletion by digest only", async () => {
      const logs: string[] = [];
      const { local, remover } = trashable({ "a.bin": [1, 2, 3] });
      await new SafeExecutor(local as never, remote(), state(), identity, "[]", remover, undefined, (message) => logs.push(message)).execute(deleteLocal("a.bin", 3, 10));

      expect(logs.some((line) => /^remote delete applied path-digest=[0-9a-f]{8}$/.test(line))).toBe(true);
      expect(logs.join("\n")).not.toContain("a.bin");
    });

    it("fails rather than unlinking when no remover is configured at all", async () => {
      const local = vault({ "a.bin": [1, 2, 3] });
      const result = await new SafeExecutor(local as never, remote(), state(), identity, "[]").execute(deleteLocal("a.bin", 3, 10));
      expect(result).toMatchObject({ status: "failed", reason: "file-manager-unavailable" });
      expect(local.files.has("a.bin")).toBe(true);
    });
  });

  describe("prune-baseline (state GC)", () => {
    it("removes the baseline entry and touches nothing else", async () => {
      const local = vault({ "other.bin": [1, 2, 3] });
      const deleted: string[] = [];
      const saved: StateStore = { ...state(), delete: async (key) => { deleted.push(key); } };
      const result = await new SafeExecutor(local as never, remote(), saved, identity, "[]").execute({ type: "prune-baseline", key: "gone.bin", reason: "test" });
      expect(result).toEqual({ status: "applied", key: "gone.bin" });
      expect(deleted).toEqual(["gone.bin"]);
      // No Vault content and no remote call was involved.
      expect(local.files.has("other.bin")).toBe(true);
    });

    it("reports a failed bookkeeping removal as unresolved instead of claiming success", async () => {
      const result = await new SafeExecutor(vault({}) as never, remote(), state(true), identity, "[]").execute({ type: "prune-baseline", key: "gone.bin", reason: "test" });
      expect(result).toEqual({ status: "unresolved", key: "gone.bin", reason: "state-commit-failed" });
    });
  });
  it("creates the missing parent folders before writing a nested download", async () => {
    const local = vault({}), saved = state();
    const nested: Extract<SyncOperation, { type: "download" }> = { type: "download", key: "a/b/c/note.md", reason: "test", expectedLocal: { kind: "absent" }, expectedRemote: { key: "a/b/c/note.md", size: 2, etag: "old", lastModified: 1 } };

    await expect(new SafeExecutor(local as never, remote(), saved, identity, "[]").execute(nested)).resolves.toMatchObject({ status: "applied", key: "a/b/c/note.md", localWrite: { key: "a/b/c/note.md", size: 2, mtime: 20 } });
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
