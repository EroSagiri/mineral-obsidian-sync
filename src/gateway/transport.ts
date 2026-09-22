import { requestUrl } from "obsidian";
import { GatewayRequestError } from "./errors";
import type { GatewayErrorKind } from "./errors";

export interface GatewayHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  token: string;
  /** Control-plane calls are bounded so a hung Gateway cannot stall a cycle's exit handshake. */
  timeoutMs: number;
}

export interface GatewayHttpResponse { status: number; text: string; }

export interface GatewayTransport { send(request: GatewayHttpRequest): Promise<GatewayHttpResponse>; }

/**
 * Gateway HTTP transport, built on the same `requestUrl` primitive the R2 path uses.
 *
 * It is a separate class on purpose. The frozen R2 transport, signer, and `R2Client` stay generic and
 * gain no knowledge of a control plane; sharing `requestUrl` is a platform fact, not a design
 * coupling, and it is the only primitive verified to work on both desktop and Android.
 *
 * `throw: false` is not optional here either: a 401 from the Gateway is a *result* this client must
 * classify, not an exception. The long-lived token travels in an `Authorization` header only — never
 * in a URL, a log line, or a diagnostic.
 */
export class RequestUrlGatewayTransport implements GatewayTransport {
  async send(request: GatewayHttpRequest): Promise<GatewayHttpResponse> {
    let timeout: unknown;
    try {
      const response = await Promise.race([
        requestUrl({ url: request.url, method: request.method, headers: { ...request.headers, Authorization: `Bearer ${request.token}` }, body: request.body, throw: false }),
        new Promise<never>((_resolve, reject) => {
          timeout = window.setTimeout(() => reject(new GatewayRequestError("timeout", new Error("gateway request timed out"))), request.timeoutMs);
        }),
      ]);
      return { status: response.status, text: response.text };
    } catch (error) {
      if (error instanceof GatewayRequestError) throw error;
      throw new GatewayRequestError("transport", error);
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout as number);
    }
  }
}

export { GatewayRequestError };
export type { GatewayErrorKind };
