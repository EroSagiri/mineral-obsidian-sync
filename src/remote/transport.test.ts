import { describe, expect, it } from "vitest";
import { RemoteTransportError } from "./errors";
import { setRequestUrlHandler } from "../../test/obsidian";
import type { MockRequestUrlRequest } from "../../test/obsidian";
import { SettingsCredentialProvider } from "./credentials";
import { RequestUrlTransport } from "./transport";

const RESPONSE_URL = "https://r2.example/bucket/sync/.mineral-sync-test/20260922T001500Z/x.txt";

function respondWith(status: number): { received: () => MockRequestUrlRequest | undefined } {
  let received: MockRequestUrlRequest | undefined;
  setRequestUrlHandler(async (request) => {
    received = request;
    return { status, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) };
  });
  return { received: () => received };
}

describe("transport and credentials", () => {
  it("exposes settings credentials without inventing a session token", async () => {
    await expect(new SettingsCredentialProvider({ accessKeyId: "id", secretAccessKey: "secret" }).getCredentials()).resolves.toEqual({ accessKeyId: "id", secretAccessKey: "secret" });
  });
  it("forwards the signed method, URL, headers, and bytes without mutation", async () => {
    let received: unknown;
    setRequestUrlHandler(async (request) => { received = request; return { status: 200, headers: { etag: '"a"' }, text: "", arrayBuffer: new ArrayBuffer(0), json: {} }; });
    const body = new Uint8Array([0, 255, 2]).buffer;
    await new RequestUrlTransport().send({ method: "PUT", url: "https://r2.example/bucket/a%20b?x=1", headers: { Authorization: "signed", "content-type": "application/octet-stream" }, body });
    expect(received).toMatchObject({ method: "PUT", url: "https://r2.example/bucket/a%20b?x=1", headers: { Authorization: "signed", "content-type": "application/octet-stream" }, body });
  });

  // The three tests below pin the transport contract: a completed exchange is a response, whatever
  // its status; only a request that never completed throws. Without `throw: false` every 4xx would
  // reject, and "absent" / "stale" / "auth" would become indistinguishable from "network down".

  it("always disables requestUrl's implicit throwing", async () => {
    const { received } = respondWith(412);
    const response = await new RequestUrlTransport().send({ method: "PUT", url: RESPONSE_URL, headers: {}, body: new Uint8Array([1]).buffer });
    expect(received()?.throw).toBe(false);
    expect(response.status).toBe(412);
  });

  it("returns 4xx and 5xx as ordinary responses instead of throwing", async () => {
    for (const status of [400, 401, 403, 404, 409, 412, 429, 500, 503]) {
      respondWith(status);
      await expect(new RequestUrlTransport().send({ method: "GET", url: RESPONSE_URL, headers: {} })).resolves.toMatchObject({ status });
    }
  });

  it("surfaces a request that never completed as RemoteTransportError", async () => {
    setRequestUrlHandler(async () => { throw new Error("Request failed, net::ERR_CONNECTION_RESET"); });
    const send = new RequestUrlTransport().send({ method: "HEAD", url: RESPONSE_URL, headers: {} });
    await expect(send).rejects.toBeInstanceOf(RemoteTransportError);
    await expect(send).rejects.toMatchObject({ name: "RemoteTransportError", operation: "HEAD" });
  });
});
