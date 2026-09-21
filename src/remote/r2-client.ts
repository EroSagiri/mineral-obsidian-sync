import { RemoteHttpError, RemoteObjectChangedError } from "./errors";
import { SettingsCredentialProvider } from "./credentials";
import { Aws4FetchSigner, type RequestSigner } from "./signer";
import { RequestUrlTransport, type HttpTransport } from "./transport";
import { normalizePrefix, remoteObjectKey, vaultKeyFromRemote } from "../sync/path";
import type { RemoteEntry, RemoteIdentity, RemoteVersion } from "../sync/types";

export interface R2Configuration { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; remotePrefix: string; }
export interface R2Client {
  listObjects(): Promise<RemoteEntry[]>;
  /** Used for capability probing and diagnostics; the execution path never issues a HEAD. */
  headObject(key: string, options?: { ifMatch?: string }): Promise<RemoteEntry>;
  getObject(key: string, options?: { ifMatch?: string }): Promise<ArrayBuffer>;
  putObject(key: string, body: ArrayBuffer, options: { ifMatch?: string; ifNoneMatch?: "*" }): Promise<RemoteVersion>;
}
export { RemoteHttpError, RemoteObjectChangedError } from "./errors";

function xmlText(parent: Element, name: string): string | undefined { return parent.getElementsByTagName(name).item(0)?.textContent ?? undefined; }
function xmlEntries(xml: string, prefix: string): { entries: RemoteEntry[]; next?: string; truncated: boolean } {
  const document = new DOMParser().parseFromString(xml, "application/xml"); if (document.querySelector("parsererror")) throw new Error("R2 returned an invalid ListObjectsV2 response");
  const entries: RemoteEntry[] = [];
  for (const node of Array.from(document.getElementsByTagName("Contents"))) {
    const objectKey = xmlText(node, "Key"); if (!objectKey) continue; const key = vaultKeyFromRemote(prefix, objectKey); if (!key) continue;
    const size = Number(xmlText(node, "Size")), lastModified = Date.parse(xmlText(node, "LastModified") ?? "");
    if (!Number.isFinite(size) || !Number.isFinite(lastModified)) throw new Error("R2 list response contained invalid object metadata");
    entries.push({ key, size, etag: xmlText(node, "ETag")?.replace(/^"|"$/g, ""), lastModified });
  }
  return { entries, next: xmlText(document.documentElement, "NextContinuationToken"), truncated: xmlText(document.documentElement, "IsTruncated") === "true" };
}
function header(headers: Record<string, string>, name: string): string | undefined { return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]; }
function objectEntry(key: string, headers: Record<string, string>): RemoteEntry {
  const size = Number(header(headers, "content-length")), lastModified = Date.parse(header(headers, "last-modified") ?? "");
  if (!Number.isFinite(size) || !Number.isFinite(lastModified)) throw new Error("R2 object response lacked canonical metadata");
  return { key, size, etag: header(headers, "etag")?.replace(/^"|"$/g, ""), lastModified };
}
export function remoteIdentity(config: Pick<R2Configuration, "endpoint" | "bucket" | "remotePrefix">): RemoteIdentity {
  return { endpoint: new URL(config.endpoint).toString().replace(/\/$/, ""), bucket: config.bucket, remotePrefix: normalizePrefix(config.remotePrefix) };
}

/** S3 semantics only; signing and HTTP are injected, separate boundaries. */
export class SignedR2ListClient implements R2Client {
  private readonly signer: RequestSigner; private readonly transport: HttpTransport;
  constructor(private readonly config: R2Configuration, now: () => Date = () => new Date(), signer?: RequestSigner, transport?: HttpTransport) { this.signer = signer ?? new Aws4FetchSigner(new SettingsCredentialProvider(config), now); this.transport = transport ?? new RequestUrlTransport(); }
  private validate(): void {
    if (!this.config.endpoint || !this.config.bucket || !this.config.accessKeyId || !this.config.secretAccessKey) throw new Error("R2 endpoint, bucket, access key ID, and secret access key are required");
    if (!/^https:\/\//i.test(this.config.endpoint)) throw new Error("R2 endpoint must use HTTPS");
  }
  private objectUrl(key: string): string { const objectKey = remoteObjectKey(this.config.remotePrefix, key).split("/").map(encodeURIComponent).join("/"); return new URL(`/${encodeURIComponent(this.config.bucket)}/${objectKey}`, this.config.endpoint).toString(); }
  private async send(method: string, url: string, headers: Record<string, string> = {}, body?: ArrayBuffer) { this.validate(); return this.transport.send(await this.signer.sign({ method, url, headers, body })); }
  async listObjects(): Promise<RemoteEntry[]> {
    const output = new Map<string, RemoteEntry>(); let token: string | undefined; const prefix = normalizePrefix(this.config.remotePrefix);
    do {
      const url = new URL(`/${encodeURIComponent(this.config.bucket)}`, this.config.endpoint); url.search = new URLSearchParams({ "list-type": "2", ...(prefix ? { prefix } : {}), ...(token ? { "continuation-token": token } : {}) }).toString();
      const response = await this.send("GET", url.toString()); if (response.status < 200 || response.status >= 300) throw new RemoteHttpError("ListObjectsV2", response.status);
      const page = xmlEntries(response.text, this.config.remotePrefix); for (const entry of page.entries) output.set(entry.key, entry); token = page.truncated ? page.next : undefined;
      if (page.truncated && !token) throw new Error("R2 list response was truncated without a continuation token");
    } while (token);
    return [...output.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
  async headObject(key: string, options: { ifMatch?: string } = {}): Promise<RemoteEntry> { const response = await this.send("HEAD", this.objectUrl(key), options.ifMatch ? { "if-match": `"${options.ifMatch}"` } : {}); if (response.status === 412) throw new RemoteObjectChangedError(); if (response.status < 200 || response.status >= 300) throw new RemoteHttpError("HeadObject", response.status); return objectEntry(key, response.headers); }
  async getObject(key: string, options: { ifMatch?: string } = {}): Promise<ArrayBuffer> { const response = await this.send("GET", this.objectUrl(key), options.ifMatch ? { "if-match": `"${options.ifMatch}"` } : {}); if (response.status === 412) throw new RemoteObjectChangedError(); if (response.status < 200 || response.status >= 300) throw new RemoteHttpError("GetObject", response.status); return response.arrayBuffer; }
  /**
   * Conditional write, recorded **from its own response**.
   *
   * A 2xx with an ETag settles the fact this layer is responsible for: the bytes we sent are now the
   * remote version identified by that ETag. No follow-up HEAD is issued — it would not make the
   * write more atomic, it would add a second race window (another writer advancing the object
   * between our PUT and our confirmation), and it would turn a *successful* write into an
   * `unresolved` one. Any later change to the object is exactly what the next reconciliation's
   * three-way comparison is for.
   *
   * `lastModified` is intentionally not invented: `PutObject` does not return a server timestamp.
   */
  async putObject(key: string, body: ArrayBuffer, options: { ifMatch?: string; ifNoneMatch?: "*" }): Promise<RemoteVersion> {
    const headers: Record<string, string> = { "content-type": "application/octet-stream" }; if (options.ifMatch) headers["if-match"] = `"${options.ifMatch}"`; if (options.ifNoneMatch) headers["if-none-match"] = options.ifNoneMatch;
    const response = await this.send("PUT", this.objectUrl(key), headers, body); if (response.status === 412) throw new RemoteObjectChangedError(); if (response.status < 200 || response.status >= 300) throw new RemoteHttpError("PutObject", response.status);
    const etag = header(response.headers, "etag")?.replace(/^"|"$/g, "");
    // R2 returns the object's ETag on PutObject. Without it the write landed but cannot be recorded,
    // so the outcome stays unknown: never repair this with a HEAD.
    if (!etag) throw new Error("R2 PutObject returned no ETag; the baseline cannot be recorded from this response");
    return { size: body.byteLength, etag };
  }
}
