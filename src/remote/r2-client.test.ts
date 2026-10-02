import { describe, expect, it, vi } from "vitest";
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
    expect(request?.headers?.Authorization).toContain("SignedHeaders=accept-encoding;host;if-match;x-amz-content-sha256;x-amz-date");
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

describe("SignedR2ListClient.headObject metadata recovery", () => {
  it("measures the observed revision when HEAD omits Content-Length", async () => {
    const requests: Array<{ method?: string; headers?: Record<string, string> }> = [];
    setRequestUrlHandler(async request => {
      requests.push(request);
      return { status: 200, arrayBuffer: new Uint8Array([1, 2, 3]).buffer, text: "", json: {}, headers: { etag: '"observed"', "last-modified": "Thu, 01 Oct 2026 12:08:33 GMT" } };
    });
    expect(await client().headObject("未命名.md")).toMatchObject({ size: 3, etag: "observed" });
    expect(requests.map(request => request.method)).toEqual(["HEAD", "GET"]);
    expect(requests[1].headers?.["if-match"]).toBe('"observed"');
    expect(requests.every(request => request.headers?.["accept-encoding"] === "identity")).toBe(true);
  });
  it("rejects a replacement between HEAD and metadata recovery", async () => {
    setRequestUrlHandler(async request => ({ status: request.method === "HEAD" ? 200 : 412, arrayBuffer: new ArrayBuffer(0), text: "", json: {}, headers: { etag: '"observed"', "last-modified": "Thu, 01 Oct 2026 12:08:33 GMT" } }));
    await expect(client().headObject("未命名.md")).rejects.toBeInstanceOf(RemoteObjectChangedError);
  });
});

describe("SignedR2ListClient.verifyObjectVersion", () => {
  it("accepts a successful conditional HEAD even when R2 omits object metadata", async () => {
    let request: { method?: string; headers?: Record<string, string> } | undefined;
    setRequestUrlHandler(async (value) => {
      request = value;
      return { status: 200, arrayBuffer: new ArrayBuffer(0), text: "", headers: {}, json: {} };
    });

    await expect(client().verifyObjectVersion("deleted.md", "etag-a")).resolves.toBeUndefined();
    expect(request?.method).toBe("HEAD");
    expect(request?.headers?.["if-match"]).toBe('"etag-a"');
  });

  it("still treats a failed precondition as a changed object", async () => {
    setRequestUrlHandler(async () => ({ status: 412, arrayBuffer: new ArrayBuffer(0), text: "", headers: {}, json: {} }));
    await expect(client().verifyObjectVersion("deleted.md", "etag-a")).rejects.toBeInstanceOf(RemoteObjectChangedError);
  });
});

describe("remote recycle bin", () => {
  const deletion = { protocol: 1 as const, path: "deleted.md", deletedRemoteETag: "A", createdAt: "2026-10-02T12:00:00.000Z" };
  it("archives exact binary bytes before publishing deletion and removing the live object", async () => {
    const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: ArrayBuffer }> = [];
    setRequestUrlHandler(async request => {
      calls.push({ method: request.method ?? "GET", url: request.url, headers: request.headers ?? {}, body: request.body as ArrayBuffer });
      return { status: 200, headers: { etag: '"A"', "content-type": "image/png" }, text: "", arrayBuffer: new Uint8Array([0, 255, 13]).buffer, json: {} };
    });
    await client().recycleObject(deletion);
    expect(calls.map(c => c.method)).toEqual(["GET", "PUT", "PUT", "HEAD", "DELETE"]);
    expect(calls[0].headers["if-match"]).toBe('"A"');
    expect(calls[1].url).toContain("/.mineral/versions/");
    expect(calls[1].headers["x-amz-meta-reason"]).toBe("delete");
    expect(calls[1].headers["content-type"]).toBe("image/png");
    expect(new Uint8Array(calls[1].body!)).toEqual(new Uint8Array([0, 255, 13]));
    expect(calls[4].url).toContain("/deleted.md");
  });

  it("does not publish deletion or remove the source when archiving fails", async () => {
    const methods: string[] = [];
    setRequestUrlHandler(async request => {
      methods.push(request.method ?? "GET");
      return { status: request.method === "PUT" ? 503 : 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: {} };
    });
    await expect(client().recycleObject(deletion)).rejects.toBeInstanceOf(RemoteHttpError);
    expect(methods).toEqual(["GET", "PUT"]);
  });

  it("keeps a later source version when the final version check detects a change", async () => {
    const methods: string[] = [];
    setRequestUrlHandler(async request => {
      methods.push(request.method ?? "GET");
      return { status: request.method === "HEAD" ? 412 : 200, headers: { etag: '"A"' }, text: "", arrayBuffer: new ArrayBuffer(0), json: {} };
    });
    await expect(client().recycleObject(deletion)).rejects.toBeInstanceOf(RemoteObjectChangedError);
    expect(methods).not.toContain("DELETE");
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
  it("reads both namespaces and preserves original acceptance time when deduplicating migrated records", async () => {
    const record = { protocol: 1 as const, path: "migrated.md", deletedRemoteETag: "E", createdAt: "2026-09-01T00:00:00.000Z", r2AcceptedAt: "2026-09-01T00:00:01.000Z" };
    const key = await tombstoneKey(record.path, record.deletedRemoteETag);
    const legacy = key.replace(".mineral/", ".mineral-sync/");
    const subject = client() as unknown as {
      listRaw(prefix: string): Promise<Array<{ key: string; size: number; etag?: string; lastModified: number }>>;
      getObject(key: string): Promise<ArrayBuffer>;
      listTombstones(): ReturnType<SignedR2ListClient["listTombstones"]>;
    };
    subject.listRaw = async prefix => [{ key: `sync/${prefix.includes(".mineral-sync/") ? legacy : key}`, size: 1, etag: "metadata", lastModified: Date.parse("2026-10-02T00:00:00.000Z") }];
    subject.getObject = async () => encodeTombstone(record);
    expect(await subject.listTombstones()).toEqual([{ tombstone: record, metadataETag: "metadata", metadataLastModified: Date.parse(record.r2AcceptedAt) }]);
  });
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

  it("bounds tombstone GET fan-out while preserving the listed order", async () => {
    const records = Array.from({ length: 17 }, (_, index) => ({
      protocol: 1 as const,
      path: `note-${index}.md`,
      deletedRemoteETag: `etag-${index}`,
      createdAt: "2026-09-22T00:00:00.000Z",
    }));
    const keys = await Promise.all(records.map(record => tombstoneKey(record.path, record.deletedRemoteETag)));
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const subject = client() as unknown as {
      listRaw(prefix: string): Promise<Array<{ key: string; size: number; etag?: string; lastModified: number }>>;
      getObject(key: string, options?: { ifMatch?: string }): Promise<ArrayBuffer>;
      listTombstones(): ReturnType<SignedR2ListClient["listTombstones"]>;
    };
    subject.listRaw = async () => keys.map((key, index) => ({ key: `sync/${key}`, size: 1, etag: `meta-${index}`, lastModified: index }));
    subject.getObject = async (key) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
      return encodeTombstone(records[keys.indexOf(key)]!);
    };

    const pending = subject.listTombstones();
    await vi.waitFor(() => expect(releases).toHaveLength(8));
    expect(maximum).toBe(8);
    releases.splice(0).forEach(release => release());
    await vi.waitFor(() => expect(releases).toHaveLength(8));
    releases.splice(0).forEach(release => release());
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.splice(0).forEach(release => release());
    await expect(pending).resolves.toMatchObject(records.map(tombstone => ({ tombstone })));
    expect(maximum).toBe(8);
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
    const requests: Array<{ url: string; method?: string; headers?: Record<string, string> }> = [];
    setRequestUrlHandler(async (value) => { requests.push(value); return { status: 204, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: {} }; });

    await expect(client().deleteTombstone(record)).resolves.toBeUndefined();

    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.method === "DELETE")).toBe(true);
    expect(requests[0].url).toContain(`/bucket/sync/${await tombstoneKey(record.path, record.deletedRemoteETag)}`);
    expect(requests[1].url).toContain("/bucket/sync/.mineral-sync/tombstones/");
    // The key is a digest of the path *and* the deleted version, so there is no newer record at the same
    // key that a precondition could protect; the request carries none.
    expect(requests.every(request => request.headers?.["if-match"] === undefined)).toBe(true);
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
