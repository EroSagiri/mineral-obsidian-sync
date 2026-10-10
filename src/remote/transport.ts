import { requestUrl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import { RemoteTransportError } from "./errors";
import type { SignedRequest } from "./signer";

export interface HttpResponse { status: number; headers: Record<string, string>; text: string; arrayBuffer: ArrayBuffer; }
export interface HttpTransport { send(request: SignedRequest): Promise<HttpResponse>; }

/**
 * requestUrl-only transport. It forwards the signer output without changing URL, headers, or bytes.
 *
 * ## The contract
 *
 * ```text
 * a completed HTTP exchange → a response, whatever the status
 * no exchange at all        → a thrown RemoteTransportError
 * ```
 *
 * **HTTP errors are not transport errors.** `404`, `412`, `429` and `5xx` are successful HTTP
 * exchanges with a different status, and the layers above must be able to read `response.status` to
 * tell "the object does not exist" from "my observation is stale" from "the server is broken".
 *
 * `throw: false` is what makes that true: Obsidian's `requestUrl` otherwise rejects on any status
 * >= 400. It is not optional, and it is asserted by a test — remove it and every conditional path
 * collapses into an opaque failure on every platform.
 *
 * ## Measured platform note (Obsidian for Android, 2026-09-21)
 *
 * With `throw: false` in place, `GET 404`, `GET 412`, `PUT 412` and `HEAD 200` all arrive as typed
 * responses on Android. A **HEAD whose response is non-2xx** still throws
 * `Request Failed. IOException Stream closed`: a HEAD response has no body, and the native bridge
 * fails while reading it. That is a platform limitation below this boundary, not a missing
 * `throw: false`, and it is not worked around here. It is harmless for this plugin because a HEAD
 * never gates a write — see `docs/development.md`.
 */
export class RequestUrlTransport implements HttpTransport {
  async send(request: SignedRequest): Promise<HttpResponse> {
    let response: RequestUrlResponse;
    try {
      response = await requestUrl({ url: request.url, method: request.method, headers: request.headers, body: request.body, throw: false });
    } catch (error) {
      throw new RemoteTransportError(request.method, error);
    }
    return { status: response.status, headers: response.headers, text: response.text, arrayBuffer: response.arrayBuffer };
  }
}
