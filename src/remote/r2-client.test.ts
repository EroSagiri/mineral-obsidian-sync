import { describe, expect, it } from "vitest";
import { setRequestUrlHandler } from "../../test/obsidian";
import { RemoteHttpError, RemoteObjectChangedError, SignedR2ListClient } from "./r2-client";

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
