import type { SignedRequest } from "../../src/remote/signer";
import type { HttpResponse, HttpTransport } from "../../src/remote/transport";

/**
 * Node-only diagnostic transport.
 *
 * This is **not** the product transport. It exists so a developer can verify real aws4fetch
 * signing and real Cloudflare R2 conditional semantics from a terminal. A pass here is never
 * evidence that Obsidian's `requestUrl` path works: only the in-Obsidian self-test can show that.
 */
export class NodeFetchTransport implements HttpTransport {
  async send(request: SignedRequest): Promise<HttpResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body as ArrayBuffer | undefined,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const arrayBuffer = await response.arrayBuffer();
    return { status: response.status, headers, text: new TextDecoder().decode(arrayBuffer), arrayBuffer };
  }
}
