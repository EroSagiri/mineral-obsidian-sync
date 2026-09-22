/**
 * Entry point for the diagnostic bundle.
 *
 * It re-exports the product's real R2 client and installs the test-only DOMParser shim, so the
 * diagnostic exercises the same signing, the same paginated LIST, and the same XML parsing as the
 * product instead of a reimplementation.
 */
import { installDomParserShim } from "../test/integration/dom-parser-shim";
import { SignedR2ListClient } from "../src/remote/r2-client";
import { normalizePrefix, remoteObjectKey } from "../src/sync/path";
import type { R2Configuration } from "../src/remote/r2-client";
import type { HttpResponse, HttpTransport } from "../src/remote/transport";
import type { SignedRequest } from "../src/remote/signer";

installDomParserShim();

class NodeFetchTransport implements HttpTransport {
  async send(request: SignedRequest): Promise<HttpResponse> {
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body as ArrayBuffer | undefined });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => { headers[name] = value; });
    const arrayBuffer = await response.arrayBuffer();
    return { status: response.status, headers, text: new TextDecoder().decode(arrayBuffer), arrayBuffer };
  }
}

/**
 * Diagnostic-only guarded delete. The **plugin never deletes**, and Phase 3A/4C keep
 * `delete-local`/`delete-remote` hard-blocked; this exists solely so this session's probe objects can
 * be removed from R2. It is guarded with `If-Match`, so it can only remove the exact version that was
 * listed a moment earlier — if anything changed the object, R2 answers 412 and nothing is removed.
 */
export async function deleteObjectIfMatch(config: R2Configuration, key: string, etag: string): Promise<number> {
  const transport = new NodeFetchTransport();
  const client = new SignedR2ListClient(config, () => new Date(), undefined, transport);
  const objectKey = remoteObjectKey(config.remotePrefix, key).split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const url = new URL(`/${encodeURIComponent(config.bucket)}/${objectKey}`, config.endpoint).toString();
  // The client keeps its signer private. This narrow cast reuses that exact signer rather than
  // reimplementing SigV4, which would be a second, untested signing path.
  const signer = (client as unknown as { signer: { sign(request: { method: string; url: string; headers: Record<string, string> }): Promise<SignedRequest> } }).signer;
  const response = await transport.send(await signer.sign({ method: "DELETE", url, headers: { "if-match": `"${etag}"` } }));
  return response.status;
}

export { SignedR2ListClient, normalizePrefix, remoteObjectKey };
export { canonicalKey } from "../src/sync/path";
