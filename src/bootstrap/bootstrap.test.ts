import { describe, expect, it } from "vitest";
import { buildBootstrapResult, type BootstrapContentReader } from "./bootstrap";
import { LocalFileChangedError } from "../local/read-local";
import { RemoteObjectChangedError } from "../remote/errors";
import type { LocalEntry, PreviousEntry, RemoteEntry } from "../sync/types";

const encoder = new TextEncoder();
const local = (key: string, size: number, mtime = 1): LocalEntry => ({ key, size, mtime });
const remote = (key: string, size: number, etag = "e1"): RemoteEntry => ({ key, size, etag, lastModified: 2 });
const previous = (key: string): PreviousEntry => ({ key, local: { size: 3, mtime: 1 }, remote: { size: 3, etag: "e1", lastModified: 2 }, syncedAt: 1 });

function reader(localBodies: Record<string, string | Uint8Array>, remoteBodies: Record<string, string | Uint8Array>): BootstrapContentReader {
  const bytes = (body: string | Uint8Array) => typeof body === "string" ? encoder.encode(body).buffer : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  return { readLocal: async (key) => bytes(localBodies[key]), readRemote: async (key) => bytes(remoteBodies[key]) };
}

describe("buildBootstrapResult", () => {
  it("baselines equal-size, SHA-256-identical bytes and gives the pure planner a noop", async () => {
    const result = await buildBootstrapResult(new Map([["a.bin", local("a.bin", 3)]]), new Map([["a.bin", remote("a.bin", 3)]]), new Map(), reader({ "a.bin": "abc" }, { "a.bin": "abc" }));
    expect(result.diagnostics).toMatchObject({ bootstrapCandidates: 1, verifiedIdentical: 1, hashedFiles: 1, hashedBytes: 6, unresolved: 0 });
    expect(result.baselineCandidates.get("a.bin")).toMatchObject({ local: { hash: expect.any(String) }, remote: { hash: expect.any(String) } });
    expect(result.plan.operations).toEqual([expect.objectContaining({ type: "noop" })]);
  });

  it("keeps equal-size but different content as a conflict", async () => {
    const result = await buildBootstrapResult(new Map([["a", local("a", 3)]]), new Map([["a", remote("a", 3)]]), new Map(), reader({ a: "abc" }, { a: "xyz" }));
    expect(result.diagnostics).toMatchObject({ verifiedIdentical: 0, differentContent: 1 });
    expect(result.baselineCandidates.size).toBe(0);
    expect(result.plan.operations).toEqual([expect.objectContaining({ type: "conflict", conflict: "both-created-different" })]);
  });

  it("skips reads and hashing for different metadata sizes", async () => {
    let reads = 0;
    const source: BootstrapContentReader = { readLocal: async () => { reads++; return new ArrayBuffer(0); }, readRemote: async () => { reads++; return new ArrayBuffer(0); } };
    const result = await buildBootstrapResult(new Map([["a", local("a", 3)]]), new Map([["a", remote("a", 4)]]), new Map(), source);
    expect(reads).toBe(0); expect(result.diagnostics).toMatchObject({ bootstrapCandidates: 0, hashedFiles: 0, differentContent: 1 });
  });

  it("does not baseline a failed remote read", async () => {
    const source: BootstrapContentReader = { readLocal: async () => encoder.encode("abc").buffer, readRemote: async () => { throw new Error("offline"); } };
    const result = await buildBootstrapResult(new Map([["a", local("a", 3)]]), new Map([["a", remote("a", 3)]]), new Map(), source);
    expect(result.diagnostics.unresolved).toBe(1); expect(result.baselineCandidates.size).toBe(0);
  });

  it("does not baseline if the local file changed during verification", async () => {
    const source: BootstrapContentReader = { readLocal: async () => { throw new LocalFileChangedError(); }, readRemote: async () => encoder.encode("abc").buffer };
    const result = await buildBootstrapResult(new Map([["a", local("a", 3)]]), new Map([["a", remote("a", 3)]]), new Map(), source);
    expect(result.diagnostics.unresolved).toBe(1); expect(result.baselineCandidates.size).toBe(0);
  });

  it("does not baseline when the conditional remote read reports a changed ETag", async () => {
    let seen: string | undefined;
    const source: BootstrapContentReader = { readLocal: async () => encoder.encode("abc").buffer, readRemote: async (_key, entry) => { seen = entry.etag; throw new RemoteObjectChangedError(); } };
    const result = await buildBootstrapResult(new Map([["a", local("a", 3)]]), new Map([["a", remote("a", 3, "stable")]]), new Map(), source);
    expect(seen).toBe("stable"); expect(result.diagnostics.unresolved).toBe(1); expect(result.baselineCandidates.size).toBe(0);
  });

  it("handles binary bytes rather than UTF-8 text", async () => {
    const body = new Uint8Array([0, 255, 17]);
    const result = await buildBootstrapResult(new Map([["image.png", local("image.png", 3)]]), new Map([["image.png", remote("image.png", 3)]]), new Map(), reader({ "image.png": body }, { "image.png": new Uint8Array(body) }));
    expect(result.diagnostics.verifiedIdentical).toBe(1);
  });

  it("creates a partial baseline only for verified pairs", async () => {
    const locals = new Map([["same", local("same", 3)], ["different", local("different", 3)], ["local-only", local("local-only", 1)]]);
    const remotes = new Map([["same", remote("same", 3)], ["different", remote("different", 3)], ["remote-only", remote("remote-only", 1)]]);
    const result = await buildBootstrapResult(locals, remotes, new Map(), reader({ same: "abc", different: "abc" }, { same: "abc", different: "xyz" }));
    expect([...result.baselineCandidates.keys()]).toEqual(["same"]);
    expect(result.plan.operations.map((entry) => entry.type)).toEqual(["conflict", "upload", "download", "noop"]);
  });

  it("does not rehash an unchanged, already-baselined entry", async () => {
    let reads = 0;
    const source: BootstrapContentReader = { readLocal: async () => { reads++; return encoder.encode("abc").buffer; }, readRemote: async () => { reads++; return encoder.encode("abc").buffer; } };
    const result = await buildBootstrapResult(new Map([["a", local("a", 3)]]), new Map([["a", remote("a", 3)]]), new Map([["a", previous("a")]]), source);
    expect(reads).toBe(0); expect(result.baselineCandidates.size).toBe(0); expect(result.plan.operations[0].type).toBe("noop");
  });
});
