import { RemoteHttpError, RemoteObjectChangedError } from "./errors";
import { SettingsCredentialProvider } from "./credentials";
import { Aws4FetchSigner, type RequestSigner } from "./signer";
import { RequestUrlTransport, type HttpTransport } from "./transport";
import { normalizePrefix, remoteObjectKey, vaultKeyFromRemote } from "../sync/path";
import type { RemoteEntry, RemoteIdentity, RemoteVersion } from "../sync/types";
import { TOMBSTONE_NAMESPACE, encodeTombstone, isInternalRemoteKey, parseTombstone, tombstoneKey, type RemoteDeletion, type RemoteTombstone } from "./tombstones";

export interface R2Configuration { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; remotePrefix: string; }
export type RemoteDebugLogger = (message: string) => void;
export interface R2Client {
  listObjects(): Promise<RemoteEntry[]>;
  /** Lists validated logical-deletion metadata separately from user objects. */
  listTombstones?(): Promise<RemoteDeletion[]>;
  /** Used for capability probing and diagnostics; the execution path never issues a HEAD. */
  headObject(key: string, options?: { ifMatch?: string }): Promise<RemoteEntry>;
  getObject(key: string, options?: { ifMatch?: string }): Promise<ArrayBuffer>;
  putObject(key: string, body: ArrayBuffer, options: { ifMatch?: string; ifNoneMatch?: "*" }): Promise<RemoteVersion>;
  /** Immutable conditional create. A duplicate of the same path/version is an equivalent success. */
  putTombstone?(record: RemoteTombstone): Promise<RemoteDeletion>;
  /** Removes one tombstone record. Only retention calls this; it never touches a user object. */
  deleteTombstone?(record: RemoteTombstone): Promise<void>;
  /** Physically removes one user object. Only retention calls this, and only for content already deleted. */
  deleteObject?(key: string): Promise<void>;
}
export { RemoteHttpError, RemoteObjectChangedError } from "./errors";

function xmlText(parent: Element, name: string): string | undefined { return parent.getElementsByTagName(name).item(0)?.textContent ?? undefined; }
function xmlEntries(xml: string, prefix: string): { entries: RemoteEntry[]; next?: string; truncated: boolean } {
  const document = new DOMParser().parseFromString(xml, "application/xml"); if (document.querySelector("parsererror")) throw new Error("R2 returned an invalid ListObjectsV2 response");
  const entries: RemoteEntry[] = [];
  for (const node of Array.from(document.getElementsByTagName("Contents"))) {
    const objectKey = xmlText(node, "Key"); if (!objectKey) continue; const key = vaultKeyFromRemote(prefix, objectKey); if (!key || isInternalRemoteKey(key)) continue;
    const size = Number(xmlText(node, "Size")), lastModified = Date.parse(xmlText(node, "LastModified") ?? "");
    if (!Number.isFinite(size) || !Number.isFinite(lastModified)) throw new Error("R2 list response contained invalid object metadata");
    entries.push({ key, size, etag: xmlText(node, "ETag")?.replace(/^"|"$/g, ""), lastModified });
  }
  return { entries, next: xmlText(document.documentElement, "NextContinuationToken"), truncated: xmlText(document.documentElement, "IsTruncated") === "true" };
}
function xmlRawEntries(xml: string): { entries: Array<{ key: string; size: number; etag?: string; lastModified: number }>; next?: string; truncated: boolean } {
  const document = new DOMParser().parseFromString(xml, "application/xml"); if (document.querySelector("parsererror")) throw new Error("R2 returned an invalid ListObjectsV2 response");
  const entries = Array.from(document.getElementsByTagName("Contents")).map((node) => {
    const key = xmlText(node, "Key"), size = Number(xmlText(node, "Size")), lastModified = Date.parse(xmlText(node, "LastModified") ?? "");
    if (!key || !Number.isFinite(size) || !Number.isFinite(lastModified)) throw new Error("R2 list response contained invalid object metadata");
    return { key, size, etag: xmlText(node, "ETag")?.replace(/^"|"$/g, ""), lastModified };
  });
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
  constructor(private readonly config: R2Configuration, now: () => Date = () => new Date(), signer?: RequestSigner, transport?: HttpTransport, private readonly debug?: RemoteDebugLogger) { this.signer = signer ?? new Aws4FetchSigner(new SettingsCredentialProvider(config), now); this.transport = transport ?? new RequestUrlTransport(); }
  private validate(): void {
    if (!this.config.endpoint || !this.config.bucket || !this.config.accessKeyId || !this.config.secretAccessKey) throw new Error("R2 endpoint, bucket, access key ID, and secret access key are required");
    if (!/^https:\/\//i.test(this.config.endpoint)) throw new Error("R2 endpoint must use HTTPS");
  }
  private objectUrl(key: string): string { const objectKey = remoteObjectKey(this.config.remotePrefix, key).split("/").map(encodeURIComponent).join("/"); return new URL(`/${encodeURIComponent(this.config.bucket)}/${objectKey}`, this.config.endpoint).toString(); }
  /** Debug telemetry deliberately reports no URL, path, header, credential, or body data. */
  private async send(operation: string, method: string, url: string, headers: Record<string, string> = {}, body?: ArrayBuffer) {
    const startedAt = Date.now();
    try {
      this.validate();
      const response = await this.transport.send(await this.signer.sign({ method, url, headers, body }));
      this.debug?.(`r2 request operation=${operation} method=${method} status=${response.status} durationMs=${Date.now() - startedAt}`);
      return response;
    } catch (error) {
      this.debug?.(`r2 request operation=${operation} method=${method} status=transport-error durationMs=${Date.now() - startedAt}`);
      throw error;
    }
  }
  async listObjects(): Promise<RemoteEntry[]> {
    const output = new Map<string, RemoteEntry>(); let token: string | undefined; const prefix = normalizePrefix(this.config.remotePrefix);
    do {
      const url = new URL(`/${encodeURIComponent(this.config.bucket)}`, this.config.endpoint); url.search = new URLSearchParams({ "list-type": "2", ...(prefix ? { prefix } : {}), ...(token ? { "continuation-token": token } : {}) }).toString();
      const response = await this.send("ListObjectsV2", "GET", url.toString()); if (response.status < 200 || response.status >= 300) throw new RemoteHttpError("ListObjectsV2", response.status);
      const page = xmlEntries(response.text, this.config.remotePrefix); for (const entry of page.entries) output.set(entry.key, entry); token = page.truncated ? page.next : undefined;
      if (page.truncated && !token) throw new Error("R2 list response was truncated without a continuation token");
    } while (token);
    return [...output.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
  private async listRaw(prefix: string): Promise<Array<{ key: string; size: number; etag?: string; lastModified: number }>> {
    const output: Array<{ key: string; size: number; etag?: string; lastModified: number }> = []; let token: string | undefined;
    do {
      const url = new URL(`/${encodeURIComponent(this.config.bucket)}`, this.config.endpoint);
      url.search = new URLSearchParams({ "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) }).toString();
      const response = await this.send("ListTombstonesV2", "GET", url.toString()); if (response.status < 200 || response.status >= 300) throw new RemoteHttpError("ListObjectsV2", response.status);
      const page = xmlRawEntries(response.text); output.push(...page.entries); token = page.truncated ? page.next : undefined;
      if (page.truncated && !token) throw new Error("R2 list response was truncated without a continuation token");
    } while (token);
    return output;
  }
  async listTombstones(): Promise<RemoteDeletion[]> {
    const prefix = `${normalizePrefix(this.config.remotePrefix)}${TOMBSTONE_NAMESPACE}`;
    // These immutable metadata reads are independent. Keep their original listing order in the
    // returned array, but do not make one slow R2 GET delay every other tombstone verification.
    const resolved = await Promise.all((await this.listRaw(prefix)).map(async (entry): Promise<RemoteDeletion | undefined> => {
      const key = vaultKeyFromRemote(this.config.remotePrefix, entry.key);
      if (!key || !isInternalRemoteKey(key) || !entry.etag) throw new Error("Tombstone metadata key is invalid");
      let body: ArrayBuffer;
      try { body = await this.getObject(key, { ifMatch: entry.etag }); }
      catch (error) {
        // Retention can remove a record between this listing and this read. A record that is already
        // gone has nothing left to say, and its absence is still visible in the object listing, so the
        // scan reports what remains instead of failing over a tombstone that no longer exists.
        if (error instanceof RemoteHttpError && error.status === 404) return undefined;
        throw error;
      }
      const record = parseTombstone(body);
      const expectedKey = await tombstoneKey(record.path, record.deletedRemoteETag);
      if (key !== expectedKey) throw new Error("Tombstone metadata key does not match its record");
      // The listing's own timestamp is R2's clock, which is what retention compares against the object's.
      return { tombstone: record, metadataETag: entry.etag, metadataLastModified: entry.lastModified };
    }));
    return resolved.filter((deletion): deletion is RemoteDeletion => deletion !== undefined);
  }
  async headObject(key: string, options: { ifMatch?: string } = {}): Promise<RemoteEntry> { const response = await this.send("HeadObject", "HEAD", this.objectUrl(key), options.ifMatch ? { "if-match": `"${options.ifMatch}"` } : {}); if (response.status === 412) throw new RemoteObjectChangedError(); if (response.status < 200 || response.status >= 300) throw new RemoteHttpError("HeadObject", response.status); return objectEntry(key, response.headers); }
  async getObject(key: string, options: { ifMatch?: string } = {}): Promise<ArrayBuffer> { const response = await this.send("GetObject", "GET", this.objectUrl(key), options.ifMatch ? { "if-match": `"${options.ifMatch}"` } : {}); if (response.status === 412) throw new RemoteObjectChangedError(); if (response.status < 200 || response.status >= 300) throw new RemoteHttpError("GetObject", response.status); return response.arrayBuffer; }
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
    const response = await this.send("PutObject", "PUT", this.objectUrl(key), headers, body); if (response.status === 412) throw new RemoteObjectChangedError(); if (response.status < 200 || response.status >= 300) throw new RemoteHttpError("PutObject", response.status);
    const etag = header(response.headers, "etag")?.replace(/^"|"$/g, "");
    // R2 returns the object's ETag on PutObject. Without it the write landed but cannot be recorded,
    // so the outcome stays unknown: never repair this with a HEAD.
    if (!etag) throw new Error("R2 PutObject returned no ETag; the baseline cannot be recorded from this response");
    return { size: body.byteLength, etag };
  }
  async putTombstone(record: RemoteTombstone): Promise<RemoteDeletion> {
    const key = await tombstoneKey(record.path, record.deletedRemoteETag);
    try {
      const version = await this.putObject(key, encodeTombstone(record), { ifNoneMatch: "*" });
      return { tombstone: record, metadataETag: version.etag };
    } catch (error) {
      if (!(error instanceof RemoteObjectChangedError)) throw error;
      // A matching immutable record is an idempotent success. Any malformed/mismatched record is
      // a hard metadata error, never permission to overwrite it.
      const body = await this.getObject(key);
      const existing = parseTombstone(body);
      if (existing.path !== record.path || existing.deletedRemoteETag !== record.deletedRemoteETag) throw new Error("Existing tombstone does not match its immutable identity");
      return { tombstone: existing };
    }
  }
  /**
   * Deletes one tombstone record, for retention.
   *
   * No precondition is needed and none is sent: a tombstone's key is a digest of the path *and* the
   * exact deleted version, so the record at that key can only ever be this one. There is no newer
   * record at the same key to protect, and therefore nothing a conditional request could add.
   */
  async deleteTombstone(record: RemoteTombstone): Promise<void> {
    const key = await tombstoneKey(record.path, record.deletedRemoteETag);
    await this.delete(key, "DeleteTombstone");
  }

  /**
   * Physically removes one user object.
   *
   * Reserved for retention: the caller has already proved that the bytes are a version every device has
   * been told is deleted, and that nothing has written them again since. An ordinary deletion never comes
   * here — it writes a tombstone and leaves the object where it is, which is what makes deletion
   * recoverable in the first place.
   */
  async deleteObject(key: string): Promise<void> {
    await this.delete(key, "DeleteObject");
  }

  private async delete(key: string, operation: string): Promise<void> {
    const response = await this.send(operation, "DELETE", this.objectUrl(key));
    // An object that is already gone is the state this call exists to produce.
    if (response.status === 404) return;
    if (response.status < 200 || response.status >= 300) throw new RemoteHttpError(operation, response.status);
  }
}
