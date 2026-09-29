import type { ColdAuthorityCommit, ColdAuthorityRequest, ColdAuthorityResult, DocumentEpoch, HotAcquireRequest, HotAcquireResult, HotReleaseRequest, HotReleaseResult, HotRemoteObservation, PathBinding } from "@mineral/sync-core/hot-protocol";
import type { NamespaceIntent, NamespaceResult } from "@mineral/sync-core/namespace-protocol";

/**
 * A request without the protocol field, for the union-typed bodies.
 *
 * `Omit` over a union collapses it to the common keys, which silently drops every field that
 * distinguishes one intent from another; a distributive conditional keeps each member intact.
 */
type WithoutProtocol<T> = T extends { protocol: number } ? Omit<T, "protocol"> : never;

/**
 * The plugin's typed client for the Gateway's hot surface.
 *
 * Every call is shape-checked on the way *in* as well as on the way out: a control plane that answers
 * with something unexpected must produce a classified failure the UI can show, never a partially
 * applied decision. Nothing here decides anything — the server owns the namespace, the room owns the
 * document — so this module's only job is to be a faithful, bounded transport.
 */

export interface HotHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface HotHttpResponse { status: number; text: string; }

export type HotTransport = (request: HotHttpRequest) => Promise<HotHttpResponse>;

export interface HotClientConfig {
  /** Gateway base URL, e.g. `https://sync.example.com`. */
  endpoint: string;
  token: string;
  /** Derived from the R2 identity; never configured by the user. */
  channel: string;
}

export type HotClientFailure = {
  kind: "disabled" | "misconfigured" | "transport" | "timeout" | "unauthorized" | "server" | "malformed";
  status?: number;
  detail?: string;
};

export class HotClientError extends Error {
  constructor(readonly failure: HotClientFailure, message: string) {
    super(message);
    this.name = "HotClientError";
  }
}

const CONTROL_TIMEOUT_MS = 15_000;
/** A socket connects with a short-lived ticket; the URL never carries the long-lived token. */
export interface HotSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
}

export type HotSocketFactory = (url: string) => HotSocket;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export class HotGatewayClient {
  constructor(
    private readonly config: HotClientConfig,
    private readonly transport: HotTransport,
    private readonly openSocket: HotSocketFactory,
    private readonly now: () => number = Date.now,
  ) {}

  private url(action: string, query = ""): string {
    const base = this.config.endpoint.replace(/\/+$/, "");
    return `${base}/v1/channels/${this.config.channel}/hot/${action}${query}`;
  }

  private async request(action: string, body: unknown, query = ""): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!this.config.endpoint || !this.config.token || !this.config.channel) {
      throw new HotClientError({ kind: "misconfigured" }, "hot sync requires a Gateway endpoint, token, and a derivable channel");
    }
    const response = await this.transport({
      url: this.url(action, query),
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs: CONTROL_TIMEOUT_MS,
    });
    if (response.status === 401) throw new HotClientError({ kind: "unauthorized", status: 401 }, "the Gateway rejected the token");
    if (response.status >= 500) throw new HotClientError({ kind: "server", status: response.status }, `the Gateway answered ${response.status}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text) as unknown;
    } catch {
      throw new HotClientError({ kind: "malformed", status: response.status }, "the Gateway answered with a body that is not JSON");
    }
    if (!isRecord(parsed)) throw new HotClientError({ kind: "malformed", status: response.status }, "the Gateway answered with a body that is not an object");
    return { status: response.status, body: parsed };
  }

  /**
   * `POST /hot/acquire` — adopt or join a document.
   *
   * A `conflict` outcome is a *result*, not an error: it is how the server tells the plugin "your local
   * file is not a version this room knows", and the plugin must surface that decision rather than
   * retry it.
   */
  async acquire(input: WithoutProtocol<HotAcquireRequest>): Promise<HotAcquireResult> {
    const { body } = await this.request("acquire", { protocol: 1, ...input });
    if (typeof body.outcome !== "string" || !["joined", "created", "conflict", "rejected"].includes(body.outcome)) {
      throw new HotClientError({ kind: "malformed" }, "acquire answered without a usable outcome");
    }
    return body as unknown as HotAcquireResult;
  }

  async release(input: WithoutProtocol<HotReleaseRequest>): Promise<HotReleaseResult> {
    const { body } = await this.request("release", { protocol: 1, ...input });
    return body as unknown as HotReleaseResult;
  }

  async namespace(input: WithoutProtocol<NamespaceIntent>): Promise<NamespaceResult> {
    const { body } = await this.request("namespace", { protocol: 1, ...input });
    return body as unknown as NamespaceResult;
  }

  async pathStatus(canonicalPath: string): Promise<{ binding: PathBinding | null; remote: HotRemoteObservation | null; hotOwned: boolean }> {
    const { body } = await this.request("path", undefined, `?path=${encodeURIComponent(canonicalPath)}`);
    return body as unknown as { binding: PathBinding | null; remote: HotRemoteObservation | null; hotOwned: boolean };
  }

  /**
   * The decision a human made about a frozen conflict.
   *
   * The body carries no content on purpose: the bytes already exist on one side or the other, and a
   * resolution that had to transmit them could fail halfway and leave both sides believing different
   * things.
   */
  async resolveConflict(input: { operationId: string; canonicalPath: string; documentId: string; epoch: DocumentEpoch; decision: "keep-local" | "accept-remote" }): Promise<{ outcome: "resolved" | "abandoned" | "not-found" }> {
    const { body } = await this.request("resolve", { protocol: 1, ...input });
    return body as unknown as { outcome: "resolved" | "abandoned" | "not-found" };
  }

  async coldAcquire(input: WithoutProtocol<ColdAuthorityRequest>): Promise<ColdAuthorityResult> {
    const { body } = await this.request("cold/acquire", { protocol: 1, ...input });
    return body as unknown as ColdAuthorityResult;
  }

  async coldCommit(input: WithoutProtocol<ColdAuthorityCommit>): Promise<{ outcome: string; hotOwned: boolean }> {
    const { body } = await this.request("cold/commit", { protocol: 1, ...input });
    return body as unknown as { outcome: string; hotOwned: boolean };
  }

  async coldRelease(token: string): Promise<boolean> {
    const { body } = await this.request("cold/release", { protocol: 1, token });
    return body.released === true;
  }

  /** Opens the session socket. The ticket is short-lived and bound to this document, epoch, and client. */
  connect(ticket: string): HotSocket {
    const base = this.config.endpoint.replace(/\/+$/, "").replace(/^http/, "ws");
    return this.openSocket(`${base}/v1/channels/${this.config.channel}/hot/session?ticket=${encodeURIComponent(ticket)}`);
  }

  timestamp(): number {
    return this.now();
  }
}


