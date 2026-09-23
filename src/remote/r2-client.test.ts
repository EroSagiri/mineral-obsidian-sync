import { describe, expect, it } from "vitest";
import { setRequestUrlHandler } from "../../test/obsidian";
import { RemoteHttpError, RemoteObjectChangedError, SignedR2ListClient } from "./r2-client";
import { encodeTombstone, tombstoneKey } from "./tombstones";

const client = () => new SignedR2ListClient({ endpoint: "https://example.r2.cloudflarestorage.com", bucket: "bucket", accessKeyId: "key", secretAccessKey: "secret", remotePrefix: "sync" }, () => new Date("2026-09-21T00:00:00.000Z"));

describe("SignedR2ListClient.getObject", () => {
  it("signs an If-Match conditional GET using the scan ETag", async () => {
    let request: { url: string; headers?: Record<string, string> } | undefined;
    setRequestUrlHandler(async (value) => {
      request = value;
      return { status: 200, arrayBuffer: new Uint8Array([1, 2, 3]).buffer, text: "", headers: {}, json: {} };
    });
    await expect(client().getObject("folder/a.bin", { ifMatch: "etag-a" })).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(request?.url).toContain("/bucket/sync/folder/a.bin");
    expect(request?.headers?.host).toBeUndefined();
    expect(request?.headers?.["if-match"]).toBe('"etag-a"');
    expect(request?.headers?.Authorization).toContain("SignedHeaders=host;if-match;x-amz-content-sha256;x-amz-date");
  });

  it("treats a 412 conditional read as stale metadata without accepting a body", async () => {
    setRequestUrlHandler(async () => ({ status: 412, arrayBuffer: new ArrayBuffer(0), text: "", headers: {}, json: {} }));
    await expect(client().getObject("a.bin", { ifMatch: "old" })).rejects.toBeInstanceOf(RemoteObjectChangedError);
  });

  it("keeps authorization failures typed instead of treating them as stale", async () => {
    setRequestUrlHandler(async () => ({ status: 403, arrayBuffer: new ArrayBuffer(0), text: "", headers: {}, json: {} }));
    await expect(client().getObject("a.bin", { ifMatch: "old" })).rejects.toMatchObject({ name: "RemoteHttpError", status: 403, operation: "GetObject" });
  });
});

describe("SignedR2ListClient.putObject", () => {
  it("records the baseline from the PUT response itself, with no confirmation HEAD", async () => {
    const methods: string[] = [];
    setRequestUrlHandler(async (request) => {
      methods.push((request.method ?? "GET").toUpperCase());
      return { status: 200, headers: { etag: '"etag-b"' }, text: "", arrayBuffer: new ArrayBuffer(0), json: {} };
    });

    const body = new Uint8Array([1, 2, 3]).buffer;
    await expect(client().putObject("folder/a.bin", body, { ifNoneMatch: "*" })).resolves.toEqual({ size: 3, etag: "etag-b" });
    expect(methods).toEqual(["PUT"]);
  });

  it("treats a 2xx without an ETag as unresolvable instead of repairing it with a HEAD", async () => {
    const methods: string[] = [];
    setRequestUrlHandler(async (request) => {
      methods.push((request.method ?? "GET").toUpperCase());
      return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: {} };
    });

    await expect(client().putObject("folder/a.bin", new Uint8Array([1]).buffer, { ifMatch: "etag-a" })).rejects.toThrow("returned no ETag");
    expect(methods).toEqual(["PUT"]);
  });
});

describe("SignedR2ListClient.listTombstones", () => {
  it("reads independent immutable records concurrently while retaining list order", async () => {
    const first = { protocol: 1, path: "first.md", deletedRemoteETag: "first-etag", createdAt: "2026-09-22T00:00:00.000Z" } as const;
    const second = { protocol: 1, path: "second.md", deletedRemoteETag: "second-etag", createdAt: "2026-09-22T00:00:00.000Z" } as const;
    const [firstKey, secondKey] = await Promise.all([tombstoneKey(first.path, first.deletedRemoteETag), tombstoneKey(second.path, second.deletedRemoteETag)]);
    let getCalls = 0;
    let releaseReads: (() => void) | undefined;
    const bothReadsStarted = new Promise<void>((resolve) => { releaseReads = resolve; });
    let observeBothReads: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { observeBothReads = resolve; });
    const subject = client() as unknown as {
      listRaw(prefix: string): Promise<Array<{ key: string; size: number; etag?: string; lastModified: number }>>;
      getObject(key: string, options?: { ifMatch?: string }): Promise<ArrayBuffer>;
      listTombstones(): ReturnType<SignedR2ListClient["listTombstones"]>;
    };
    subject.listRaw = async () => [
      { key: `sync/${firstKey}`, size: 1, etag: "meta-1", lastModified: 0 },
      { key: `sync/${secondKey}`, size: 1, etag: "meta-2", lastModified: 0 },
    ];
    subject.getObject = async (key) => {
      getCalls++;
      if (getCalls === 2) observeBothReads?.();
      await bothReadsStarted;
      return key === firstKey ? encodeTombstone(first) : encodeTombstone(second);
    };
    const pending = subject.listTombstones();
    await started;
    expect(getCalls).toBe(2);
    releaseReads?.();
    await expect(pending).resolves.toMatchObject([{ tombstone: first }, { tombstone: second }]);
  });

  it("skips a record that retention removed between the listing and the read", async () => {
    const record = { protocol: 1, path: "gone.md", deletedRemoteETag: "etag", createdAt: "2026-09-22T00:00:00.000Z" } as const;
    const key = await tombstoneKey(record.path, record.deletedRemoteETag);
    const subject = client() as unknown as {
      listRaw(prefix: string): Promise<Array<{ key: string; size: number; etag?: string; lastModified: number }>>;
      getObject(key: string, options?: { ifMatch?: string }): Promise<ArrayBuffer>;
      listTombstones(): ReturnType<SignedR2ListClient["listTombstones"]>;
    };
    subject.listRaw = async () => [{ key: `sync/${key}`, size: 1, etag: "meta", lastModified: 0 }];
    subject.getObject = async () => { throw new RemoteHttpError("GetObject", 404); };

    // A record that is already gone has nothing left to say, and its absence is still visible in the
    // object listing — so a concurrent cleanup must not turn a scan into a failure.
    await expect(subject.listTombstones()).resolves.toEqual([]);
  });

  it("still fails on a record it can see but cannot read", async () => {
    const record = { protocol: 1, path: "held.md", deletedRemoteETag: "etag", createdAt: "2026-09-22T00:00:00.000Z" } as const;
    const key = await tombstoneKey(record.path, record.deletedRemoteETag);
    const subject = client() as unknown as {
      listRaw(prefix: string): Promise<Array<{ key: string; size: number; etag?: string; lastModified: number }>>;
      getObject(key: string, options?: { ifMatch?: string }): Promise<ArrayBuffer>;
      listTombstones(): ReturnType<SignedR2ListClient["listTombstones"]>;
    };
    subject.listRaw = async () => [{ key: `sync/${key}`, size: 1, etag: "meta", lastModified: 0 }];
    subject.getObject = async () => { throw new RemoteHttpError("GetObject", 403); };

    // "We are not allowed to read it" is not "it is gone": a permission problem must stay visible.
    await expect(subject.listTombstones()).rejects.toMatchObject({ status: 403 });
  });
});

describe("SignedR2ListClient.deleteTombstone / deleteObject", () => {
  const record = { protocol: 1, path: "notes/a.md", deletedRemoteETag: "etag-A", createdAt: "2026-09-22T00:00:00.000Z" } as const;

  it("deletes a tombstone at its own content-addressed key, unconditionally", async () => {
    let request: { url: string; method?: string; headers?: Record<string, string> } | undefined;
    setRequestUrlHandler(async (value) => { request = value; return { status: 204, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: {} }; });

    await expect(client().deleteTombstone(record)).resolves.toBeUndefined();

    expect(request?.method).toBe("DELETE");
    expect(request?.url).toContain(`/bucket/sync/${await tombstoneKey(record.path, record.deletedRemoteETag)}`);
    // The key is a digest of the path *and* the deleted version, so there is no newer record at the same
    // key that a precondition could protect; the request carries none.
    expect(request?.headers?.["if-match"]).toBeUndefined();
  });

  it("deletes a user object at its own key, which is the path itself", async () => {
    // The one call in this client that removes user content. It is addressed by path like every other
    // object operation, so nothing about the tombstone namespace leaks into it.
    let request: { url: string; method?: string } | undefined;
    setRequestUrlHandler(async (value) => { request = value; return { status: 204, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: {} }; });

    await expect(client().deleteObject("notes/a.md")).resolves.toBeUndefined();

    expect(request?.method).toBe("DELETE");
    expect(request?.url).toContain("/bucket/sync/notes/a.md");
  });

  it("treats an already-absent object as the state it wanted to produce", async () => {
    setRequestUrlHandler(async () => ({ status: 404, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: {} }));
    await expect(client().deleteObject("notes/a.md")).resolves.toBeUndefined();
    await expect(client().deleteTombstone(record)).resolves.toBeUndefined();
  });

  it("keeps a refused delete typed, and names which deletion it was", async () => {
    setRequestUrlHandler(async () => ({ status: 403, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: {} }));
    await expect(client().deleteTombstone(record)).rejects.toMatchObject({ operation: "DeleteTombstone", status: 403 });
    await expect(client().deleteObject("notes/a.md")).rejects.toMatchObject({ operation: "DeleteObject", status: 403 });
  });
});
