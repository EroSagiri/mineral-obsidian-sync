import { requestUrl } from "obsidian";
import type { SignedRequest } from "./signer";

export interface HttpResponse { status: number; headers: Record<string, string>; text: string; arrayBuffer: ArrayBuffer; }
export interface HttpTransport { send(request: SignedRequest): Promise<HttpResponse>; }

/** requestUrl-only transport. It forwards the signer output without changing URL, headers, or bytes. */
export class RequestUrlTransport implements HttpTransport {
  async send(request: SignedRequest): Promise<HttpResponse> {
    const response = await requestUrl({ url: request.url, method: request.method, headers: request.headers, body: request.body, throw: false });
    return { status: response.status, headers: response.headers, text: response.text, arrayBuffer: response.arrayBuffer };
  }
}
