import { describe, expect, it } from "vitest";
import { migrateInternalStorage, migrationTarget } from "../scripts/migrate-internal-storage.mjs";
import { tombstoneKey } from "@mineral/sync-core/tombstones";
import { mkdtemp, readFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = { endpoint: "https://example.r2.cloudflarestorage.com", bucket: "bucket", accessKeyId: "test", secretAccessKey: "test", remotePrefix: "vault" };
const acceptedAt = "2026-09-01T00:00:00.000Z";
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

function harness(initial: Array<[string, Uint8Array, Record<string, string>]> = []) {
  let counter = 0;
  const objects = new Map(initial.map(([key, bytes, metadata]) => [key, { bytes, headers: new Headers({ etag: `"E${++counter}"`, "content-type": "application/octet-stream", ...metadata }) }]));
  const methods: string[] = [];
  const readEncodings: Array<string | null> = [];
  const send = async (input: string | URL, init: RequestInit) => {
    const url = new URL(input);
    const key = decodeURIComponent(url.pathname.slice("/bucket/vault/".length));
    const method = init.method!;
    methods.push(method);
    if (method === "GET" || method === "HEAD") readEncodings.push(new Headers(init.headers).get("accept-encoding"));
    if (url.searchParams.has("list-type")) {
      const prefix = url.searchParams.get("prefix")!.slice("vault/".length);
      const entries = [...objects].filter(([key]) => key.startsWith(prefix));
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${entries.map(([key, value]) => `<Contents><Key>${xml(`vault/${key}`)}</Key><ETag>${xml(value.headers.get("etag")!)}</ETag><LastModified>${acceptedAt}</LastModified></Contents>`).join("")}</ListBucketResult>`);
    }
    const object = objects.get(key);
    const headers = new Headers(init.headers);
    if (method === "PUT") {
      if (object && headers.get("if-none-match") === "*") return new Response(null, { status: 412 });
      headers.delete("if-none-match");
      headers.set("etag", `"E${++counter}"`);
      objects.set(key, { bytes: new Uint8Array(init.body as Uint8Array), headers });
      return new Response(null, { headers });
    }
    if (!object) return new Response(null, { status: 404 });
    if (headers.has("if-match") && headers.get("if-match") !== object.headers.get("etag")) return new Response(null, { status: 412 });
    if (method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
    return new Response(method === "HEAD" ? null : object.bytes.slice(), { headers: object.headers });
  };
  return { objects, methods, readEncodings, send };
}

describe("internal storage migration", () => {
  it("plans without writing and keeps history and trash copies distinct", async () => {
    const state = harness([[".history/time/note.md", new Uint8Array([1]), {}], [".trash/time/note.md", new Uint8Array([2]), {}]]);
    expect(await migrateInternalStorage(config, { send: state.send })).toEqual({ planned: 2, copied: 0, verified: 0, removed: 0 });
    expect(state.methods.every(method => method === "GET")).toBe(true);
    expect(state.readEncodings.every(value => value === "identity")).toBe(true);
    expect(migrationTarget(".history/time/note.md")).not.toBe(migrationTarget(".trash/time/note.md"));
  });

  it("creates a complete local backup without applying any remote mutations", async () => {
    const source = ".trash/time/note.md";
    const bytes = new Uint8Array([0, 255, 128]);
    const state = harness([[source, bytes, {}]]);
    const backupDir = await mkdtemp(join(tmpdir(), "mineral-migration-test-"));
    let body: string | undefined;
    try {
      expect(await migrateInternalStorage(config, { backupDir, send: state.send })).toEqual({ planned: 1, copied: 0, verified: 0, removed: 0 });
      const manifest = JSON.parse(await readFile(join(backupDir, "manifest.json"), "utf8"));
      expect(manifest.sources).toHaveLength(1);
      body = manifest.sources[0].body;
      expect(manifest.sources[0].key).toBe(source);
      expect(new Uint8Array(await readFile(join(backupDir, body!)))).toEqual(bytes);
      expect(state.methods.every(method => method === "GET")).toBe(true);
      expect(state.readEncodings.every(value => value === "identity")).toBe(true);
    } finally {
      if (body) await unlink(join(backupDir, body));
      await unlink(join(backupDir, "manifest.json")).catch(() => {});
      await rmdir(backupDir);
    }
  });

  it("copies and verifies binary versions, preserves deletion time and resumes without overwrite", async () => {
    const record = { protocol: 1, path: "note.md", deletedRemoteETag: "original", createdAt: "2026-08-31T23:00:00.000Z" };
    const newKey = (await tombstoneKey(record.path, record.deletedRemoteETag))!;
    const oldKey = newKey.replace(".mineral/", ".mineral-sync/");
    const bytes = new Uint8Array([0, 255, 128]);
    const state = harness([[".trash/time/图片.png", bytes, { "x-amz-meta-owner": "user" }], [oldKey, new TextEncoder().encode(JSON.stringify(record)), { "content-type": "application/json" }]]);
    expect(await migrateInternalStorage(config, { apply: true, send: state.send })).toEqual({ planned: 2, copied: 2, verified: 2, removed: 0 });
    expect(state.objects.get(migrationTarget(".trash/time/图片.png"))?.bytes).toEqual(bytes);
    expect(JSON.parse(new TextDecoder().decode(state.objects.get(newKey)!.bytes))).toMatchObject({ ...record, r2AcceptedAt: acceptedAt });
    expect(state.objects.has(oldKey)).toBe(true);
    expect(await migrateInternalStorage(config, { apply: true, deleteSource: true, writersPaused: true, send: state.send })).toEqual({ planned: 2, copied: 0, verified: 2, removed: 2 });
    expect(state.objects.has(oldKey)).toBe(false);
    expect([...state.objects.keys()].every(key => key.startsWith(".mineral/"))).toBe(true);
  });

  it("preserves all old objects if a destination conflicts", async () => {
    const source = ".trash/time/note.md";
    const state = harness([[source, new Uint8Array([1]), {}], [migrationTarget(source), new Uint8Array([2]), {}]]);
    await expect(migrateInternalStorage(config, { apply: true, deleteSource: true, writersPaused: true, send: state.send })).rejects.toThrow("verification failed");
    expect(state.methods).not.toContain("DELETE");
    expect(state.objects.has(source)).toBe(true);
  });

  it("requires an explicit maintenance window before retiring old records", async () => {
    const state = harness();
    await expect(migrateInternalStorage(config, { apply: true, deleteSource: true, send: state.send })).rejects.toThrow("writers-paused");
    expect(state.methods).toEqual([]);
  });

  it("does not retire any old objects if the source revision changes before retirement", async () => {
    const source = ".trash/time/note.md";
    const state = harness([[source, new Uint8Array([1]), {}]]);
    const send = async (url: string | URL, init: RequestInit) => init.method === "HEAD" ? new Response(null, { status: 412 }) : state.send(url, init);
    await expect(migrateInternalStorage(config, { apply: true, deleteSource: true, writersPaused: true, send })).rejects.toThrow("HEAD failed (412)");
    expect(state.methods).not.toContain("DELETE");
    expect(state.objects.has(source)).toBe(true);
    expect(state.objects.has(migrationTarget(source))).toBe(true);
  });
});
