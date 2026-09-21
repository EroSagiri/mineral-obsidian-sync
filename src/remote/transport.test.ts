import { describe, expect, it } from "vitest";
import { setRequestUrlHandler } from "../../test/obsidian";
import { SettingsCredentialProvider } from "./credentials";
import { RequestUrlTransport } from "./transport";

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
});
