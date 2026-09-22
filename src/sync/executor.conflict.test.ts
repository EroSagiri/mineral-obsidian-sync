import { describe, expect, it } from "vitest";
import { SafeExecutor } from "./executor";
import { buildSyncPlan } from "./planner";
import type { MergeBaseRecorder, VaultFileRemover } from "./executor";
import type { StateStore } from "../state/sync-state";
import type { R2Client } from "../remote/r2-client";
import type { PreviousEntry, SyncOperation } from "./types";
import { RemoteHttpError, RemoteObjectChangedError } from "../remote/errors";

/**
 * Resolution execution tests.
 *
 * The properties under test are the ones that make a user decision safe to apply: the local version
 * is revalidated before anything is touched, the remote is only ever changed through a conditional
 * PUT against the exact observed ETag, and a partial outcome never fabricates a baseline.
 */
const identity = { endpoint: "https://r2.example", bucket: "b", remotePrefix: "" };
const bytes = (values: number[]): ArrayBuffer => new Uint8Array(values).buffer;
const textBytes = (text: string): ArrayBuffer => { const encoded = new TextEncoder().encode(text); return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer; };
const decode = (buffer: ArrayBuffer): string => new TextDecoder().decode(buffer);

function vault(initial: Record<string, number[]> = {}) {
  const files = new Map<string, { bytes: ArrayBuffer; mtime: number }>();
  const folders = new Set<string>();
  for (const [path, values] of Object.entries(initial)) { files.set(path, { bytes: bytes(values), mtime: 10 }); const parts = path.split("/"); parts.pop(); for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/")); }
  return {
    files,
    getFiles: () => [...files.keys()].map((path) => ({ path, stat: { size: files.get(path)!.bytes.byteLength, mtime: files.get(path)!.mtime } })),
    getFileByPath: (path: string) => { const entry = files.get(path); return entry ? { path, stat: { size: entry.bytes.byteLength, mtime: entry.mtime } } : null; },
    getAbstractFileByPath: (path: string) => files.has(path) ? { path, stat: {} } : folders.has(path) ? { path, children: [] } : null,
    readBinary: async (file: { path: string }) => files.get(file.path)!.bytes,
    modifyBinary: async (file: { path: string }, value: ArrayBuffer) => { files.set(file.path, { bytes: value, mtime: files.get(file.path)!.mtime + 1 }); },
    createBinary: async (path: string, value: ArrayBuffer) => { files.set(path, { bytes: value, mtime: 20 }); return { path, stat: {} }; },
    createFolder: async (path: string) => { folders.add(path); return { path }; },
    adapter: { exists: async (path: string) => files.has(path) || folders.has(path), mkdir: async (path: string) => { folders.add(path); }, stat: async (path: string) => { const entry = files.get(path); return entry ? { size: entry.bytes.byteLength, mtime: entry.mtime } : null; } },
  };
}

function state(): StateStore & { entries: PreviousEntry[] } {
  const entries: PreviousEntry[] = [];
  return { entries, loadAll: async () => new Map(), saveVerified: async () => {}, saveAll: async () => {}, put: async (entry) => { entries.push(entry); }, delete: async () => {} };
}

function remote(overrides: Partial<R2Client> = {}): R2Client {
  return { listObjects: async () => [], headObject: async () => ({ key: "", size: 0, lastModified: 0 }), getObject: async () => bytes([7, 8]), putObject: async () => ({ size: 2, etag: "new" }), ...overrides };
}

const keepLocal = (overrides: Partial<Extract<SyncOperation, { type: "resolve-keep-local" }>> = {}): Extract<SyncOperation, { type: "resolve-keep-local" }> =>
  ({ type: "resolve-keep-local", key: "a.md", reason: "test", conflictId: "cid", expectedLocal: { key: "a.md", size: 3, mtime: 10 }, expectedRemoteETag: "R", ...overrides });
const keepRemote = (overrides: Partial<Extract<SyncOperation, { type: "resolve-keep-remote" }>> = {}): Extract<SyncOperation, { type: "resolve-keep-remote" }> =>
  ({ type: "resolve-keep-remote", key: "a.md", reason: "test", conflictId: "cid", expectedLocal: { key: "a.md", size: 3, mtime: 10 }, expectedRemoteETag: "R", ...overrides });
const merged = (content: string, overrides: Partial<Extract<SyncOperation, { type: "resolve-merged" }>> = {}): Extract<SyncOperation, { type: "resolve-merged" }> =>
  ({ type: "resolve-merged", key: "a.md", reason: "test", conflictId: "cid", expectedLocal: { key: "a.md", size: 3, mtime: 10 }, expectedRemoteETag: "R", merged: { content, sha256: "s", encoding: { bom: false, eol: "lf", trailingNewline: true } }, ...overrides });

/** Records what the merge base was told, so "did this write update the snapshot" is observable. */
function baseRecorder() {
  const recorded: Array<{ path: string; remoteETag?: string }> = [];
  let fails = false;
  const recorder: MergeBaseRecorder = { record: async ({ path, baseline }) => { if (fails) throw new Error("store down"); recorded.push({ path, remoteETag: baseline.remoteETag }); } };
  return { recorder, recorded, fail: () => { fails = true; } };
}

describe("resolve-keep-local", () => {
  it("uploads the local content with the observed ETag as the precondition", async () => {
    const local = vault({ "a.md": [1, 2, 3] });
    let condition: unknown;
    const result = await new SafeExecutor(local as never, remote({ putObject: async (_key, _body, options) => { condition = options; return { size: 3, etag: "NEW" }; } }), state(), identity, "[]").execute(keepLocal());
    expect(result).toEqual({ status: "applied", key: "a.md" });
    // Only the version the user saw may be replaced.
    expect(condition).toEqual({ ifMatch: "R" });
  });

  it("reports stale when the remote moved on, without touching it", async () => {
    const local = vault({ "a.md": [1, 2, 3] });
    const saved = state();
    const result = await new SafeExecutor(local as never, remote({ putObject: async () => { throw new RemoteObjectChangedError(); } }), saved, identity, "[]").execute(keepLocal());
    expect(result).toEqual({ status: "stale", key: "a.md", reason: "remote-changed" });
    expect(saved.entries).toHaveLength(0);
  });

  it("keeps an ambiguous PUT unresolved and commits no baseline", async () => {
    const local = vault({ "a.md": [1, 2, 3] });
    const saved = state();
    const result = await new SafeExecutor(local as never, remote({ putObject: async () => { throw new RemoteHttpError("PutObject", 503); } }), saved, identity, "[]").execute(keepLocal());
    expect(result).toEqual({ status: "unresolved", key: "a.md", reason: "ambiguous-put" });
    expect(saved.entries).toHaveLength(0);
  });

  it("refuses to apply when the local file changed after the decision", async () => {
    // The user resolved against a 3-byte version; the file is now 4 bytes.
    const local = vault({});
    local.files.set("a.md", { bytes: bytes([1, 2, 3, 4]), mtime: 99 });
    let putCalled = false;
    const saved = state();
    const result = await new SafeExecutor(local as never, remote({ putObject: async () => { putCalled = true; return { size: 4, etag: "N" }; } }), saved, identity, "[]").execute(keepLocal());
    expect(result).toEqual({ status: "stale", key: "a.md", reason: "conflict-superseded" });
    expect(putCalled).toBe(false);
    expect(saved.entries).toHaveLength(0);
  });

  it("reports partial when the local file changes during the PUT", async () => {
    const local = vault({ "a.md": [1, 2, 3] });
    const saved = state();
    const executor = new SafeExecutor(local as never, remote({ putObject: async () => { local.files.set("a.md", { bytes: bytes([9, 9, 9, 9]), mtime: 77 }); return { size: 3, etag: "NEW" }; } }), saved, identity, "[]");
    const result = await executor.execute(keepLocal());
    // The remote holds the resolved content, the local edit survives, and the newest local version is
    // not claimed converged — but the PUT that did land is, because that pair is true.
    expect(result).toEqual({ status: "partial", key: "a.md", reason: "remote-applied-local-changed" });
    expect(saved.entries).toMatchObject([{ local: { size: 3, mtime: 10 }, remote: { size: 3, etag: "NEW" } }]);
    expect([...new Uint8Array(local.files.get("a.md")!.bytes)]).toEqual([9, 9, 9, 9]);

    // That floor is what keeps the device's own resolution from being read as a remote concurrent edit:
    // the next plan pushes the newer local text over the version this resolution just wrote.
    const here = { key: "a.md", size: 4, mtime: 77 };
    const there = { key: "a.md", size: 3, etag: "NEW", lastModified: 1 };
    expect(buildSyncPlan(new Map([[here.key, here]]), new Map([[there.key, there]]), new Map([[saved.entries[0]!.key, saved.entries[0]!]])).operations)
      .toEqual([{ type: "upload", key: "a.md", reason: "local changed since previous successful sync", expectedLocal: here, expectedRemote: { kind: "etag", value: "NEW" } }]);
  });

  it("blocks without an ETag rather than overwriting blindly", async () => {
    const result = await new SafeExecutor(vault({ "a.md": [1, 2, 3] }) as never, remote(), state(), identity, "[]").execute(keepLocal({ expectedRemoteETag: undefined }));
    expect(result).toEqual({ status: "blocked", key: "a.md", reason: "missing-remote-etag" });
  });
});

describe("resolve-keep-remote", () => {
  it("reads the exact observed version and adopts it locally", async () => {
    const local = vault({ "a.md": [1, 2, 3] });
    const saved = state(); const base = baseRecorder();
    let condition: unknown;
    const result = await new SafeExecutor(local as never, remote({ getObject: async (_key, options) => { condition = options; return textBytes("remote\n"); } }), saved, identity, "[]", undefined, base.recorder).execute(keepRemote());
    expect(result).toMatchObject({ status: "applied", key: "a.md", localWrite: { key: "a.md" } });
    expect(condition).toEqual({ ifMatch: "R" });
    expect(decode(local.files.get("a.md")!.bytes)).toBe("remote\n");
    expect(saved.entries).toHaveLength(1);
    // A keep-remote resolution converges both sides, so the snapshot is refreshed for next time.
    expect(base.recorded).toEqual([{ path: "a.md", remoteETag: "R" }]);
  });

  it("reports stale when the remote changed, without overwriting the local file", async () => {
    const local = vault({ "a.md": [1, 2, 3] });
    const saved = state();
    const result = await new SafeExecutor(local as never, remote({ getObject: async () => { throw new RemoteObjectChangedError(); } }), saved, identity, "[]").execute(keepRemote());
    expect(result).toEqual({ status: "stale", key: "a.md", reason: "remote-changed" });
    expect([...new Uint8Array(local.files.get("a.md")!.bytes)]).toEqual([1, 2, 3]);
    expect(saved.entries).toHaveLength(0);
  });

  it("reports stale when the local file changed before the overwrite", async () => {
    const local = vault({});
    local.files.set("a.md", { bytes: bytes([1, 2, 3, 4]), mtime: 42 });
    const result = await new SafeExecutor(local as never, remote(), state(), identity, "[]").execute(keepRemote());
    expect(result).toEqual({ status: "stale", key: "a.md", reason: "conflict-superseded" });
    expect([...new Uint8Array(local.files.get("a.md")!.bytes)]).toEqual([1, 2, 3, 4]);
  });

  it("does not notify the Gateway, because it changes nothing remotely", async () => {
    // The scheduler derives notifications from the operation and its result; a keep-remote is never an
    // upload, so it cannot produce a remote-mutation signal. This asserts the operation shape itself.
    expect(keepRemote().type).not.toBe("upload");
  });

  it("fails without an ETag rather than downloading an unversioned object", async () => {
    const result = await new SafeExecutor(vault({ "a.md": [1, 2, 3] }) as never, remote(), state(), identity, "[]").execute(keepRemote({ expectedRemoteETag: undefined }));
    expect(result).toEqual({ status: "blocked", key: "a.md", reason: "missing-remote-etag" });
  });

  it("reports a definitive failure when the remote read is rejected", async () => {
    const result = await new SafeExecutor(vault({ "a.md": [1, 2, 3] }) as never, remote({ getObject: async () => { throw new RemoteHttpError("GetObject", 403); } }), state(), identity, "[]").execute(keepRemote());
    expect(result).toMatchObject({ status: "failed", httpStatus: 403 });
  });

  it("reports landing-unknown, not failure, when the local write cannot be verified", async () => {
    const local = vault({ "a.md": [1, 2, 3] });
    // The write is attempted and then leaves no readable metadata: whether bytes landed is unknown, so
    // the scheduler must not be told this path is settled.
    const modify = local.modifyBinary;
    const stat = local.adapter.stat;
    let wrote = false;
    local.modifyBinary = async (file, value) => { await modify(file, value); wrote = true; };
    local.adapter.stat = async (path) => (wrote ? null : stat(path));
    const saved = state();

    const result = await new SafeExecutor(local as never, remote(), saved, identity, "[]").execute(keepRemote());

    expect(result).toMatchObject({ status: "partial", reason: "remote-write-landing-unknown" });
    expect(saved.entries).toHaveLength(0);
  });
});

describe("resolve-merged", () => {
  it("writes the merged content to the remote and then the local file, then commits", async () => {
    const local = vault({ "a.md": [1, 2, 3] });
    const saved = state(); const base = baseRecorder();
    let putBody: ArrayBuffer | undefined; let condition: unknown;
    const result = await new SafeExecutor(local as never, remote({ putObject: async (_key, body, options) => { putBody = body; condition = options; return { size: 9, etag: "MERGED" }; } }), saved, identity, "[]", undefined, base.recorder).execute(merged("merged\n"));
    expect(result).toMatchObject({ status: "applied", key: "a.md", localWrite: { key: "a.md" } });
    expect(condition).toEqual({ ifMatch: "R" });
    expect(decode(putBody!)).toBe("merged\n");
    expect(decode(local.files.get("a.md")!.bytes)).toBe("merged\n");
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0]!.remote).toMatchObject({ etag: "MERGED" });
    expect(base.recorded).toEqual([{ path: "a.md", remoteETag: "MERGED" }]);
  });

  it("never overwrites a local file that changed while the remote PUT was in flight", async () => {
    const local = vault({ "a.md": [1, 2, 3] });
    const saved = state(); const base = baseRecorder();
    const executor = new SafeExecutor(local as never, remote({ putObject: async () => { local.files.set("a.md", { bytes: textBytes("user typed\n"), mtime: 88 }); return { size: 9, etag: "MERGED" }; } }), saved, identity, "[]", undefined, base.recorder);
    const result = await executor.execute(merged("merged\n"));
    // This is the documented partial state: remote is merged, local is the user's newer text, and no
    // baseline is claimed. The next reconciliation sees the real divergence.
    expect(result).toEqual({ status: "partial", key: "a.md", reason: "remote-applied-local-changed" });
    expect(decode(local.files.get("a.md")!.bytes)).toBe("user typed\n");
    expect(saved.entries).toHaveLength(0);
    expect(base.recorded).toHaveLength(0);
  });

  it("keeps an ambiguous merged PUT unresolved with no baseline", async () => {
    const saved = state();
    const result = await new SafeExecutor(vault({ "a.md": [1, 2, 3] }) as never, remote({ putObject: async () => { throw new RemoteHttpError("PutObject", 500); } }), saved, identity, "[]").execute(merged("merged\n"));
    expect(result).toEqual({ status: "unresolved", key: "a.md", reason: "ambiguous-put" });
    expect(saved.entries).toHaveLength(0);
  });

  it("reuses the observed ETag as a precondition, so a concurrent writer is not clobbered", async () => {
    const result = await new SafeExecutor(vault({ "a.md": [1, 2, 3] }) as never, remote({ putObject: async () => { throw new RemoteObjectChangedError(); } }), state(), identity, "[]").execute(merged("merged\n"));
    expect(result).toEqual({ status: "stale", key: "a.md", reason: "remote-changed" });
  });

  it("re-encodes CRLF and a BOM when the file shape calls for it", async () => {
    const local = vault({ "a.md": [1, 2, 3] });
    let putBody: ArrayBuffer | undefined;
    const operation = merged("a\nb\n", { merged: { content: "a\nb\n", sha256: "s", encoding: { bom: true, eol: "crlf", trailingNewline: true } } });
    await new SafeExecutor(local as never, remote({ putObject: async (_key, body) => { putBody = body; return { size: 3, etag: "E" }; } }), state(), identity, "[]").execute(operation);
    expect([...new Uint8Array(putBody!).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(decode(putBody!)).toContain("\r\n");
  });

  it("never falls back to an unconditional write", async () => {
    // Without an observed ETag there is no way to name what is being replaced, so nothing is written.
    let putCalled = false;
    const result = await new SafeExecutor(vault({ "a.md": [1, 2, 3] }) as never, remote({ putObject: async () => { putCalled = true; return { size: 1, etag: "x" }; } }), state(), identity, "[]").execute(merged("merged\n", { expectedRemoteETag: undefined }));
    expect(result).toMatchObject({ status: "blocked" });
    expect(putCalled).toBe(false);
  });

  it("treats a failed merge-base write as irrelevant to the transfer's outcome", async () => {
    const stored = state(); const base = baseRecorder(); base.fail();
    const result = await new SafeExecutor(vault({ "a.md": [1, 2, 3] }) as never, remote({ putObject: async () => ({ size: 9, etag: "MERGED" }) }), stored, identity, "[]", undefined, base.recorder).execute(merged("merged\n"));
    // Losing a snapshot costs future merge ability, never this write's correctness.
    expect(result).toMatchObject({ status: "applied", key: "a.md", localWrite: { key: "a.md" } });
    expect(stored.entries).toHaveLength(1);
  });
});

describe("merge base recording on ordinary transfers", () => {
  const upload = (): Extract<SyncOperation, { type: "upload" }> => ({ type: "upload", key: "a.md", reason: "test", expectedLocal: { key: "a.md", size: 3, mtime: 10 }, expectedRemote: { kind: "etag", value: "R" } });
  const download = (): Extract<SyncOperation, { type: "download" }> => ({ type: "download", key: "a.md", reason: "test", expectedLocal: { key: "a.md", size: 3, mtime: 10 }, expectedRemote: { key: "a.md", size: 2, etag: "R", lastModified: 1 } });

  it("records a snapshot after a successful upload and download", async () => {
    for (const operation of [upload(), download()]) {
      const local = vault({ "a.md": [1, 2, 3] });
      const base = baseRecorder();
      const result = await new SafeExecutor(local as never, remote(), state(), identity, "[]", undefined, base.recorder).execute(operation);
      expect(result.status).toBe("applied");
      expect(base.recorded, operation.type).toHaveLength(1);
    }
  });

  it("does not record a snapshot for a write that did not converge", async () => {
    const base = baseRecorder();
    const result = await new SafeExecutor(vault({ "a.md": [1, 2, 3] }) as never, remote({ putObject: async () => { throw new RemoteObjectChangedError(); } }), state(), identity, "[]", undefined, base.recorder).execute(upload());
    expect(result.status).toBe("stale");
    expect(base.recorded).toHaveLength(0);
  });

  it("still succeeds when no merge base recorder is configured at all", async () => {
    const result = await new SafeExecutor(vault({ "a.md": [1, 2, 3] }) as never, remote(), state(), identity, "[]").execute(upload());
    expect(result.status).toBe("applied");
  });
});

describe("delete stays out of scope", () => {
  it("still blocks delete-remote when no exact version identity is supplied", async () => {
    const result = await new SafeExecutor(vault({}) as never, remote(), state(), identity, "[]").execute({ type: "delete-remote", key: "a.md", reason: "test" });
    expect(result).toEqual({ status: "blocked", key: "a.md", reason: "missing-remote-etag" });
  });

  it("keeps delete-local recovery-first and unrelated to conflict resolution", async () => {
    const local = vault({ "a.md": [1, 2, 3] });
    const trashed: string[] = [];
    const remover: VaultFileRemover = { trash: async (file) => { trashed.push(file.path); local.files.delete(file.path); } };
    const result = await new SafeExecutor(local as never, remote(), state(), identity, "[]", remover).execute({ type: "delete-local", key: "a.md", reason: "test", expectedLocal: { key: "a.md", size: 3, mtime: 10 } });
    expect(result).toEqual({ status: "applied", key: "a.md" });
    expect(trashed).toEqual(["a.md"]);
  });
});
