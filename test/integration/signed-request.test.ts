import { describe, expect, it } from "vitest";
import { SettingsCredentialProvider } from "../../src/remote/credentials";
import type { R2Credentials } from "../../src/remote/credentials";
import { Aws4FetchSigner } from "../../src/remote/signer";
import { RequestUrlTransport } from "../../src/remote/transport";
import { setRequestUrlHandler } from "../obsidian";
import type { MockRequestUrlRequest } from "../obsidian";

const FIXED_NOW = new Date("2026-09-22T00:15:00.000Z");
const OBJECT_URL = "https://account-id.r2.cloudflarestorage.com/integration-bucket/sync/.mineral-sync-test/20260922T001500Z/binary%20payload.bin?partNumber=2&uploadId=x%2Fy";

function credentials(overrides: Partial<R2Credentials> = {}) {
  return { getCredentials: async (): Promise<R2Credentials> => ({ accessKeyId: "integration-access-key-id", secretAccessKey: "integration-secret-access-key", ...overrides }) };
}

describe("signed request immutability across RequestUrlTransport", () => {
  it("forwards method, URL, query, body bytes and every signed header unchanged", async () => {
    const signer = new Aws4FetchSigner(credentials(), () => FIXED_NOW);
    const body = new Uint8Array([0, 1, 2, 253, 254, 255]).buffer;
    const signed = await signer.sign({
      method: "PUT",
      url: OBJECT_URL,
      headers: { "content-type": "application/octet-stream", "if-none-match": "*" },
      body,
    });

    let received: MockRequestUrlRequest | undefined;
    setRequestUrlHandler(async (request) => {
      received = request;
      return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) };
    });
    await new RequestUrlTransport().send(signed);

    expect(received).toBeDefined();
    // The transport must not re-set Content-Type, re-encode the body, or reorder the query.
    expect(received!.url).toBe(signed.url);
    expect(received!.method).toBe(signed.method);
    expect(received!.headers).toEqual(signed.headers);
    expect(received!.body).toBe(body);
    expect(new Uint8Array(received!.body as ArrayBuffer)).toEqual(new Uint8Array(body));

    const headers = received!.headers!;
    expect(Object.keys(headers).sort()).toEqual(["Authorization", "content-type", "if-none-match", "x-amz-content-sha256", "x-amz-date"]);
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=integration-access-key-id\/20260922\/auto\/s3\/aws4_request, SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(headers["x-amz-date"]).toBe("20260922T001500Z");
    expect(headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers["if-none-match"]).toBe("*");
    expect(headers.host).toBeUndefined();
    expect(received!.url).toContain("partNumber=2&uploadId=x%2Fy");
  });

  it("forwards a signed conditional GET with no body", async () => {
    const signer = new Aws4FetchSigner(credentials(), () => FIXED_NOW);
    const signed = await signer.sign({ method: "GET", url: OBJECT_URL, headers: { "if-match": '"etag-a"' } });

    let received: MockRequestUrlRequest | undefined;
    setRequestUrlHandler(async (request) => {
      received = request;
      return { status: 412, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) };
    });
    const response = await new RequestUrlTransport().send(signed);

    expect(response.status).toBe(412);
    expect(received!.headers).toEqual(signed.headers);
    expect(received!.headers!["if-match"]).toBe('"etag-a"');
    expect(received!.headers!.Authorization).toContain("SignedHeaders=host;if-match;x-amz-content-sha256;x-amz-date");
    expect(received!.body).toBeUndefined();
  });

  it("does not swallow a transport failure", async () => {
    const signer = new Aws4FetchSigner(credentials(), () => FIXED_NOW);
    const signed = await signer.sign({ method: "HEAD", url: OBJECT_URL });
    setRequestUrlHandler(async () => {
      throw new Error("network down");
    });
    await expect(new RequestUrlTransport().send(signed)).rejects.toThrow("network down");
  });
});

describe("sessionToken signing regression", () => {
  it("signs x-amz-security-token when the credential provider supplies one", async () => {
    const signer = new Aws4FetchSigner(credentials({ sessionToken: "session-token-example", expiresAt: Date.now() + 60_000 }), () => FIXED_NOW);
    const signed = await signer.sign({ method: "GET", url: OBJECT_URL });

    expect(signed.headers["x-amz-security-token"]).toBe("session-token-example");
    expect(signed.headers.Authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token");
    // A temporary credential is signed as a header, never appended to the URL.
    expect(signed.url).not.toContain("X-Amz-Security-Token");
    expect(signed.url).toBe(OBJECT_URL);
  });

  it("omits the header entirely for long-lived settings credentials", async () => {
    const signer = new Aws4FetchSigner(credentials(), () => FIXED_NOW);
    const signed = await signer.sign({ method: "GET", url: OBJECT_URL });

    expect(signed.headers["x-amz-security-token"]).toBeUndefined();
    expect(signed.headers.Authorization).not.toContain("x-amz-security-token");
    expect(new SettingsCredentialProvider({ accessKeyId: "id", secretAccessKey: "secret" })).toBeDefined();
    await expect(new SettingsCredentialProvider({ accessKeyId: "id", secretAccessKey: "secret" }).getCredentials()).resolves.toEqual({ accessKeyId: "id", secretAccessKey: "secret" });
  });
});
