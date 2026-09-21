import { setRequestUrlHandler } from "../obsidian";
import type { MockRequestUrlRequest, MockRequestUrlResponse } from "../obsidian";

/**
 * An in-process S3/R2 endpoint emulator that speaks the HTTP semantics the product relies on
 * (conditional writes, conditional reads, ETag advance, paginated ListObjectsV2).
 *
 * It is installed as the `requestUrl` handler, so the real `Aws4FetchSigner` and the real
 * `RequestUrlTransport` run unchanged on top of it. It is deliberately *not* evidence of real
 * R2 behaviour: only the in-Obsidian self-test can provide that.
 */

export interface FakeObject {
  bytes: Uint8Array;
  etag: string;
  lastModified: number;
}

export interface FakeR2Options {
  bucket: string;
  accessKeyId?: string;
  pageSize?: number;
  /** Fault injection, used to prove the scenarios can actually fail. */
  ignoreIfNoneMatch?: boolean;
  ignoreIfMatch?: boolean;
  ignoreConditionalHead?: boolean;
  /** Reproduces Obsidian on Android (2026-09-21): HEAD throws at the transport layer. */
  failHead?: boolean;
  /** Reproduces the measured Android case exactly: any non-2xx HEAD response is dropped. */
  failHeadNon2xx?: boolean;
}

const EMPTY = new ArrayBuffer(0);

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripQuotes(value: string | undefined): string | undefined {
  return value?.replace(/^"|"$/g, "");
}

function bodyBytes(body: ArrayBuffer | string | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  return new Uint8Array(body.slice(0));
}

export class FakeR2 {
  readonly objects = new Map<string, FakeObject>();
  readonly requests: MockRequestUrlRequest[] = [];
  private readonly settings: Required<FakeR2Options>;
  private sequence = 0;
  private clock = Date.parse("2026-09-22T00:00:00.000Z");

  constructor(options: FakeR2Options) {
    this.settings = {
      bucket: options.bucket,
      accessKeyId: options.accessKeyId ?? "",
      pageSize: options.pageSize ?? 1000,
      ignoreIfNoneMatch: options.ignoreIfNoneMatch ?? false,
      ignoreIfMatch: options.ignoreIfMatch ?? false,
      ignoreConditionalHead: options.ignoreConditionalHead ?? false,
      failHead: options.failHead ?? false,
      failHeadNon2xx: options.failHeadNon2xx ?? false,
    };
    setRequestUrlHandler((request) => this.handle(request));
  }

  private header(request: MockRequestUrlRequest, name: string): string | undefined {
    return Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
  }

  private error(status: number, code: string): MockRequestUrlResponse {
    return {
      status,
      headers: { "content-type": "application/xml" },
      text: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
      arrayBuffer: EMPTY,
    };
  }

  private headError(status: number, code: string): MockRequestUrlResponse {
    if (this.settings.failHeadNon2xx) throw new Error("Request Failed. IOException Stream closed");
    return this.error(status, code);
  }

  private metadata(entry: FakeObject): Record<string, string> {
    return {
      etag: `"${entry.etag}"`,
      "content-length": String(entry.bytes.byteLength),
      "last-modified": new Date(entry.lastModified).toUTCString(),
      "content-type": "application/octet-stream",
    };
  }

  /** Rejects anything that is not a signed SigV4 request, so a broken signer cannot pass. */
  private authenticate(request: MockRequestUrlRequest): MockRequestUrlResponse | undefined {
    const authorization = this.header(request, "authorization");
    if (!authorization || !authorization.startsWith("AWS4-HMAC-SHA256 ")) return this.error(403, "AccessDenied");
    if (this.settings.accessKeyId && !authorization.includes(`Credential=${this.settings.accessKeyId}/`)) return this.error(403, "InvalidAccessKeyId");
    if (!/SignedHeaders=[^,]*x-amz-date/.test(authorization)) return this.error(403, "SignatureDoesNotMatch");
    if (!this.header(request, "x-amz-date")) return this.error(403, "AccessDenied");
    if (!this.header(request, "x-amz-content-sha256")) return this.error(403, "AccessDenied");
    return undefined;
  }

  async handle(request: MockRequestUrlRequest): Promise<MockRequestUrlResponse> {
    this.requests.push(request);
    const method = (request.method ?? "GET").toUpperCase();
    // Android's requestUrl fails HEAD requests at the transport layer, after the request is sent.
    if (this.settings.failHead && method === "HEAD") throw new Error("Request Failed. IOException Stream closed");
    const url = new URL(request.url);
    const denial = this.authenticate(request);
    if (denial) return denial;

    const segments = url.pathname.split("/");
    const bucket = decodeURIComponent(segments[1] ?? "");
    const key = segments.slice(2).map((segment) => decodeURIComponent(segment)).join("/");
    if (bucket !== this.settings.bucket) return this.error(404, "NoSuchBucket");
    if (method === "GET" && !key) return this.list(url);
    if (!key) return this.error(400, "InvalidRequest");
    return this.objectRequest(method, key, request);
  }

  private list(url: URL): MockRequestUrlResponse {
    const prefix = url.searchParams.get("prefix") ?? "";
    const token = url.searchParams.get("continuation-token");
    const start = token ? Number(token) : 0;
    const matching = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const page = matching.slice(start, start + this.settings.pageSize);
    const next = start + page.length;
    const truncated = next < matching.length;
    const contents = page
      .map((key) => {
        const entry = this.objects.get(key)!;
        return `<Contents><Key>${escapeXml(key)}</Key><LastModified>${new Date(entry.lastModified).toISOString()}</LastModified><ETag>"${entry.etag}"</ETag><Size>${entry.bytes.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
      })
      .join("");
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${escapeXml(this.settings.bucket)}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${this.settings.pageSize}</MaxKeys><IsTruncated>${truncated ? "true" : "false"}</IsTruncated>${truncated ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}${contents}</ListBucketResult>`;
    return { status: 200, headers: { "content-type": "application/xml" }, text: xml, arrayBuffer: EMPTY };
  }

  private objectRequest(method: string, key: string, request: MockRequestUrlRequest): MockRequestUrlResponse {
    const current = this.objects.get(key);
    const ifMatch = stripQuotes(this.header(request, "if-match"));
    const ifNoneMatch = this.header(request, "if-none-match");

    if (method === "PUT") {
      if (ifNoneMatch === "*" && !this.settings.ignoreIfNoneMatch && current) return this.error(412, "PreconditionFailed");
      if (ifMatch && !this.settings.ignoreIfMatch && current?.etag !== ifMatch) return this.error(412, "PreconditionFailed");
      const stored: FakeObject = { bytes: bodyBytes(request.body), etag: `etag-${(this.sequence += 1)}`, lastModified: this.clock++ };
      this.objects.set(key, stored);
      return { status: 200, headers: this.metadata(stored), text: "", arrayBuffer: EMPTY };
    }

    // Obsidian on Android cannot deliver a non-2xx HEAD response: no body, no status, just a throw.
    if (!current) return method === "HEAD" ? this.headError(404, "NoSuchKey") : this.error(404, "NoSuchKey");
    const conditionalHead = method === "HEAD" && this.settings.ignoreConditionalHead;
    if (ifMatch && !conditionalHead && !this.settings.ignoreIfMatch && ifMatch !== current.etag) {
      return method === "HEAD" ? this.headError(412, "PreconditionFailed") : this.error(412, "PreconditionFailed");
    }
    if (method === "HEAD") return { status: 200, headers: this.metadata(current), text: "", arrayBuffer: EMPTY };
    if (method === "GET") return { status: 200, headers: this.metadata(current), text: new TextDecoder().decode(current.bytes), arrayBuffer: current.bytes.slice(0).buffer };
    return this.error(400, "MethodNotAllowed");
  }
}
