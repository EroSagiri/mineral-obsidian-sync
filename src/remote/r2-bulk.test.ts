import { describe, expect, it } from "vitest";
import { SignedR2ListClient } from "./r2-client";
import { installDomParserShim } from "../../test/integration/dom-parser-shim";
import type { SignedRequest } from "./signer";
installDomParserShim();
const response = (text: string, status = 200) => ({ text, status, headers: {}, arrayBuffer: new ArrayBuffer(0) });
const make = (send: (request: SignedRequest) => Promise<ReturnType<typeof response>>) => new SignedR2ListClient({ endpoint: "https://r2.example", bucket: "bucket", remotePrefix: "vault/", accessKeyId: "key", secretAccessKey: "secret" }, undefined, { sign: async request => ({ ...request, headers: request.headers ?? {} }) }, { send });
const listing = (body = "", tail = "<IsTruncated>false</IsTruncated>") => `<ListBucketResult>${body}${tail}</ListBucketResult>`;
const object = (key: string) => `<Contents><Key>vault/${key}</Key><ETag>e</ETag><Size>1</Size><LastModified>2026-10-15T00:00:00Z</LastModified></Contents>`;
describe("R2 DeleteObjects", () => {
  it("parses HTTP 200 per-item successes, errors and missing results and sends explicit escaped keys", async () => {
    let sent: SignedRequest | undefined;
    const client = make(async request => { sent = request; return response('<DeleteResult><Deleted><Key>vault/f/a&amp;b.md</Key></Deleted><Error><Key>vault/f/denied.md</Key><Code>AccessDenied</Code></Error></DeleteResult>'); });
    expect(await client.deleteObjects(["f/a&b.md", "f/denied.md", "f/missing.md"])).toEqual([{ key: "f/a&b.md", status: "requested" }, { key: "f/denied.md", status: "failed", error: "AccessDenied" }, { key: "f/missing.md", status: "missing" }]);
    expect(sent?.method).toBe("POST"); expect(sent?.url).toContain("?delete");
    expect(new TextDecoder().decode(sent?.body as ArrayBuffer)).toContain("<Key>vault/f/a&amp;b.md</Key>");
    expect(sent?.headers["x-amz-checksum-sha256"]).toBeTruthy();
    expect(sent?.headers["if-match"]).toBeUndefined();
  });
  it("does not accept duplicate, malformed, network or 5xx responses as success", async () => {
    for (const send of [async () => response("<DeleteResult><Deleted><Key>vault/a.md</Key></Deleted><Error><Key>vault/a.md</Key><Code>X</Code></Error></DeleteResult>"), async () => response("<Error/>"), async () => response("bad", 503), async () => { throw Error("offline"); }]) {
      expect((await make(send).deleteObjects(["a.md"]))[0].status).toBe("unknown");
    }
    expect((await make(async () => response("", 403)).deleteObjects(["a.md"]))[0].status).toBe("failed");
  });
  it("rejects prefixes, internal paths, duplicates and oversized batches before HTTP", async () => {
    const client = make(async () => { throw Error("must not send"); });
    for (const keys of [[".mineral/a"], ["folder/"], ["../a"], ["a", "a"], Array.from({ length: 33 }, (_, i) => `${i}.md`)]) await expect(client.deleteObjects(keys)).rejects.toThrow();
  });
});
describe("concentrated absence verification", () => {
  it("reads every affected-range page before proving absence", async () => {
    const requests: SignedRequest[] = [];
    const client = make(async request => { requests.push(request); return response(requests.length === 1 ? listing(object("folder/a.md"), "<IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken>") : listing()); });
    expect([...await client.absentObjects(["folder/a.md", "folder/b.md"])]).toEqual(["folder/b.md"]);
    expect(requests).toHaveLength(2); expect(requests[1].url).toContain("continuation-token=next");
    expect(new URL(requests[0].url).searchParams.get("prefix")).toBe("vault/folder/");
  });
  it.each(["missing-token", "repeat-token", "overflow", "bad-root", "missing-truncated", "offline"])("falls back to exact HEAD for %s without trusting incomplete LIST", async kind => {
    let lists = 0, heads = 0;
    const client = make(async request => {
      if (request.method === "HEAD") { heads++; return response("", 404); }
      lists++;
      if (kind === "offline") return response("", 503);
      if (kind === "bad-root") return response("<Error>oops</Error>");
      if (kind === "missing-truncated") return response("<ListBucketResult/>");
      return response(listing("", `<IsTruncated>true</IsTruncated>${kind === "missing-token" ? "" : `<NextContinuationToken>${kind === "overflow" ? lists : "same"}</NextContinuationToken>`}`));
    });
    expect((await client.absentObjects(["folder/a.md", "folder/b.md"])).size).toBe(2);
    expect(heads).toBe(2); expect(lists).toBeLessThanOrEqual(4);
  });
  it("uses HEAD for scattered ranges and propagates uncertain observations", async () => {
    let heads = 0;
    const client = make(async request => { expect(request.method).toBe("HEAD"); heads++; return response("", 404); });
    expect((await client.absentObjects(["a/x.md", "b/y.md"])).size).toBe(2); expect(heads).toBe(2);
    await expect(make(async () => { throw Error("offline"); }).absentObjects(["a.md"])).rejects.toThrow();
  });
});
