import {
  isGatewayDirtyResult,
  isGatewayGenerationSnapshot,
  isGatewayWebSocketTicket,
  parseSubscribeMessage,
  SYNC_GATEWAY_PROTOCOL_VERSION,
} from "@mineral/sync-core/gateway-protocol";
import {
  advanceAnnouncedGeneration,
  compareRemoteGeneration,
  confirmReconciledGeneration,
  emptyGenerationCursor,
  isRemoteReconcilePending,
  parseGenerationCursor,
} from "@mineral/sync-core/sync-change";
import type { RemoteGeneration, RemoteGenerationCursor } from "@mineral/sync-core/sync-change";
import type { RemoteChange } from "@mineral/sync-core/sync-change";
import { GatewayRequestError } from "./errors";
import type { GatewayErrorKind } from "./errors";
import type { GatewayCursorStore, GatewayConnectionConfig } from "./types";
import type { GatewayTransport } from "./transport";

/** Injected so tests never depend on real time, real sockets, or a real Gateway. */
export interface GatewayClientDependencies {
  openSocket(url: string): GatewaySocketLike;
  now(): number;
  timerSet?(delayMs: number, callback: () => void): unknown;
  timerClear?(handle: unknown): void;
  debug?(message: string): void;
}

export interface GatewaySocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
}

export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;

export type GatewayConnectionState = "disabled" | "misconfigured" | "connecting" | "connected" | "backoff" | "stopped";

export type GatewayClientDiagnostics = {
  state: GatewayConnectionState;
  /** A short, non-reversible channel fingerprint; never the endpoint, bucket, or prefix. */
  channelFingerprint?: string;
  highestAnnouncedGeneration: RemoteGeneration;
  lastReconciledGeneration: RemoteGeneration;
  remotePending: boolean;
  lastErrorKind?: GatewayErrorKind;
  lastStatus?: number;
  reconnectAttempt: number;
};

export interface GatewayClientHooks {
  /** A valid generation was announced (snapshot, notification, or our own mark). */
  onAnnounced(generation: RemoteGeneration, source: "snapshot" | "notification" | "http", changes?: RemoteChange[]): void;
  onStatusChanged?(): void;
}

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];

/**
 * The plugin's Gateway control-plane client.
 *
 * It is deliberately *not* wired into the R2 transport, the signer, or `R2Client`: those layers stay
 * generic and learn nothing about a control plane. It also owns no reconciliation decision. Its only
 * job is to turn "the Gateway said the generation advanced" into a cursor update plus one callback;
 * what to do about that is entirely the scheduler's business.
 *
 * Invariant: this class may advance `highestAnnouncedGeneration`, but **never**
 * `lastReconciledGeneration`. Only `confirmReconciled()` does that, and only the scheduler calls it,
 * and only after a complete observation window has been proven.
 */
export class GatewayClient {
  private cursor: RemoteGenerationCursor = emptyGenerationCursor();
  private state: GatewayConnectionState = "disabled";
  private channel?: string;
  private configGeneration = 0;
  private socket?: GatewaySocketLike;
  private socketGeneration = -1;
  private reconnectTimer?: unknown;
  private reconnectAttempt = 0;
  private stopped = false;
  private visible = true;
  private lastErrorKind?: GatewayErrorKind;
  private lastStatus?: number;

  constructor(
    private readonly settings: () => GatewayConnectionConfig,
    private readonly transport: GatewayTransport,
    private readonly cursorStore: GatewayCursorStore,
    private readonly hooks: GatewayClientHooks,
    private readonly dependencies: GatewayClientDependencies,
  ) {}

  diagnostics(): GatewayClientDiagnostics {
    return {
      state: this.state,
      channelFingerprint: this.channel ? `${this.channel.slice(0, 6)}…${this.channel.length}` : undefined,
      highestAnnouncedGeneration: this.cursor.highestAnnouncedGeneration,
      lastReconciledGeneration: this.cursor.lastReconciledGeneration,
      remotePending: isRemoteReconcilePending(this.cursor),
      lastErrorKind: this.lastErrorKind,
      lastStatus: this.lastStatus,
      reconnectAttempt: this.reconnectAttempt,
    };
  }

  /** The exact predicate the scheduler asks before deciding whether a cycle must carry a handshake. */
  hasPending(): boolean { return isRemoteReconcilePending(this.cursor); }
  highestAnnounced(): RemoteGeneration { return this.cursor.highestAnnouncedGeneration; }
  lastReconciled(): RemoteGeneration { return this.cursor.lastReconciledGeneration; }
  connectionState(): GatewayConnectionState { return this.state; }
  currentChannel(): string | undefined { return this.channel; }
  canApplyIncrementally(generation: RemoteGeneration): boolean {
    return this.visible && compareRemoteGeneration(generation, this.cursor.lastReconciledGeneration) === 1 && BigInt(generation) === BigInt(this.cursor.lastReconciledGeneration) + 1n;
  }

  /**
   * A control-plane read. A failure is reported, never thrown into a caller doing data-plane work,
   * and it never mutates the cursor.
   */
  async readGeneration(): Promise<{ ok: true; generation: RemoteGeneration } | { ok: false; kind: GatewayErrorKind }> {
    const channel = this.channel;
    if (!channel) return { ok: false, kind: "misconfigured" };
    try {
      const response = await this.transport.send({ url: `${baseUrl(this.settings().endpoint)}/v1/channels/${channel}`, method: "GET", headers: {}, token: this.settings().token, timeoutMs: 15000 });
      this.lastStatus = response.status;
      if (response.status < 200 || response.status >= 300) return { ok: false, kind: this.fail(classifyStatus(response.status)) };
      const parsed = parseJson(response.text);
      if (!isGatewayGenerationSnapshot(parsed)) return { ok: false, kind: this.fail("malformed") };
      this.lastErrorKind = undefined;
      return { ok: true, generation: parsed.generation };
    } catch (error) {
      return { ok: false, kind: this.fail(error instanceof GatewayRequestError ? error.kind : "transport") };
    }
  }

  /**
   * Best-effort writer notification. It must never influence a data-plane result: the R2 write has
   * already succeeded (or already failed) before this runs, and a control-plane outage is not a
   * write failure. There is no retry here — delivery robustness is a Queue's job, not this client's.
   */
  async markRemoteDirty(changes?: RemoteChange[]): Promise<{ ok: true; generation: RemoteGeneration } | { ok: false; kind: GatewayErrorKind }> {
    const channel = this.channel;
    if (!this.settings().enabled) return { ok: false, kind: "misconfigured" };
    if (!channel) return { ok: false, kind: "misconfigured" };
    try {
      const response = await this.transport.send({
        url: `${baseUrl(this.settings().endpoint)}/v1/channels/${channel}/dirty`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "obsidian", kind: "upsert", ...(changes?.length ? { changes } : {}) }),
        token: this.settings().token,
        timeoutMs: 15000,
      });
      this.lastStatus = response.status;
      if (response.status < 200 || response.status >= 300) return { ok: false, kind: this.fail(classifyStatus(response.status)) };
      const parsed = parseJson(response.text);
      if (!isGatewayDirtyResult(parsed)) return { ok: false, kind: this.fail("malformed") };
      this.lastErrorKind = undefined;
      // Our own advance is an announcement, not a confirmation: the cycle that caused it never
      // observed the generation it created, so `lastReconciled` must not move here.
      this.announce(parsed.generation, "http", changes);
      return { ok: true, generation: parsed.generation };
    } catch (error) {
      return { ok: false, kind: this.fail(error instanceof GatewayRequestError ? error.kind : "transport") };
    }
  }

  /**
   * Loads the persisted cursor for the derived channel. The cursor is keyed by channel, so switching
   * prefixes can never inherit another namespace's confirmed generation.
   */
  async start(channel: string | undefined): Promise<void> { await this.configure(channel, true); }
  async reconfigure(channel: string | undefined): Promise<void> { await this.configure(channel, false); }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!visible) { this.closeSocket(); this.clearReconnect(); this.setState(this.stopped ? "stopped" : "disabled"); return; }
    void this.openSocketIfPossible();
  }

  stop(): void {
    this.stopped = true;
    this.closeSocket();
    this.clearReconnect();
    // The cursor is intentionally retained in storage: a reload must not re-run a covered window.
    this.setState("stopped");
  }

  /** Forces a reconnect without waiting for the backoff timer. Used by tests and diagnostics. */
  reconnectNow(): void { this.clearReconnect(); this.reconnectAttempt = 0; void this.openSocketIfPossible(); }

  private async configure(channel: string | undefined, initial: boolean): Promise<void> {
    this.configGeneration++;
    const generation = this.configGeneration;
    // Fence first: a late frame from the previous channel must find a mismatched generation.
    this.closeSocket();
    this.clearReconnect();
    this.channel = channel;
    this.reconnectAttempt = 0;
    if (initial) this.cursor = emptyGenerationCursor();
    if (!channel) { this.setState(this.stopped ? "stopped" : "misconfigured"); return; }
    // The cursor is loaded before any socket can deliver a generation for it.
    let stored: RemoteGenerationCursor | undefined;
    try { stored = await this.cursorStore.load(channel); } catch { this.dependencies.debug?.("gateway cursor load failed"); }
    if (this.configGeneration !== generation) return;
    this.cursor = parseGenerationCursor(stored);
    this.setState(this.stopped ? "stopped" : this.visible ? "connecting" : "disabled");
    await this.openSocketIfPossible();
  }

  private announce(generation: RemoteGeneration, source: "snapshot" | "notification" | "http", changes?: RemoteChange[]): void {
    const advanced = compareRemoteGeneration(generation, this.cursor.highestAnnouncedGeneration) > 0;
    this.cursor = advanceAnnouncedGeneration(this.cursor, generation);
    if (!advanced) return;
    this.dependencies.debug?.(`gateway announced generation=${generation} source=${source} pending=${isRemoteReconcilePending(this.cursor)}`);
    this.hooks.onAnnounced(generation, source, changes);
  }

  /** The single place `lastReconciledGeneration` can move. Only ever called after a proven window. */
  async confirmReconciled(generation: RemoteGeneration): Promise<void> {
    const next = confirmReconciledGeneration(this.cursor, generation);
    if (next === this.cursor) return;
    this.cursor = next;
    const channel = this.channel;
    if (channel) { try { await this.cursorStore.save(channel, this.cursor); } catch { this.dependencies.debug?.("gateway cursor persist failed"); } }
    this.dependencies.debug?.(`gateway reconciled generation=${generation} pending=${isRemoteReconcilePending(this.cursor)}`);
  }

  private async openSocketIfPossible(): Promise<void> {
    if (this.stopped || !this.visible) return;
    const config = this.settings();
    const channel = this.channel;
    if (!channel) { this.setState("misconfigured"); return; }
    if (!config.enabled || !config.endpoint || !config.token) { this.setState("disabled"); return; }
    const generation = this.configGeneration;
    this.setState("connecting");
    const ticket = await this.fetchTicket(channel);
    if (this.stopped || this.configGeneration !== generation || !this.visible) return;
    if (!ticket) { this.scheduleReconnect(); return; }
    let socket: GatewaySocketLike;
    try {
      // A URL is the only channel a WebView WebSocket offers, so it carries a short-lived,
      // channel-scoped ticket. The long-lived Gateway token never appears here.
      socket = this.dependencies.openSocket(`${webSocketBaseUrl(config.endpoint)}/v1/channels/${channel}/subscribe?ticket=${encodeURIComponent(ticket)}`);
    } catch {
      this.fail("transport");
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.socketGeneration = generation;
    socket.onopen = () => {
      if (this.socketGeneration !== this.configGeneration) return;
      this.reconnectAttempt = 0;
      this.setState("connected");
      this.dependencies.debug?.(`gateway socket open protocol=${SYNC_GATEWAY_PROTOCOL_VERSION}`);
    };
    socket.onmessage = (event) => this.onSocketMessage(event?.data);
    socket.onerror = () => { this.fail("transport"); };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = undefined;
      if (this.stopped || this.socketGeneration !== this.configGeneration) return;
      this.scheduleReconnect();
    };
  }

  /** Frames from a superseded connection are dropped: a stale socket cannot steer a new channel. */
  private onSocketMessage(data: unknown): void {
    if (this.stopped || this.socketGeneration !== this.configGeneration) return;
    const message = typeof data === "string" || data instanceof ArrayBuffer ? parseSubscribeMessage(data) : undefined;
    if (!message) {
      // A malformed frame must not touch the cursor; the socket stays up and waits for a valid one.
      this.dependencies.debug?.("gateway socket frame rejected");
      return;
    }
    this.announce(message.generation, message.type === "current-generation" ? "snapshot" : "notification", message.type === "remote-change" ? message.changes : undefined);
  }

  private async fetchTicket(channel: string): Promise<string | undefined> {
    try {
      const response = await this.transport.send({ url: `${baseUrl(this.settings().endpoint)}/v1/channels/${channel}/ticket`, method: "POST", headers: { "content-type": "application/json" }, body: "{}", token: this.settings().token, timeoutMs: 15000 });
      this.lastStatus = response.status;
      if (response.status < 200 || response.status >= 300) { this.fail(classifyStatus(response.status)); return undefined; }
      const parsed = parseJson(response.text);
      if (!isGatewayWebSocketTicket(parsed)) { this.fail("malformed"); return undefined; }
      this.lastErrorKind = undefined;
      return parsed.ticket;
    } catch (error) {
      this.fail(error instanceof GatewayRequestError ? error.kind : "transport");
      return undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.visible) { this.setState(this.stopped ? "stopped" : "disabled"); return; }
    this.closeSocket();
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt++;
    this.setState("backoff");
    this.dependencies.debug?.(`gateway reconnect attempt=${this.reconnectAttempt} delayMs=${delay}`);
    this.clearReconnect();
    this.reconnectTimer = this.dependencies.timerSet?.(delay, () => { this.reconnectTimer = undefined; void this.openSocketIfPossible(); });
  }

  private clearReconnect(): void {
    if (this.reconnectTimer === undefined) return;
    this.dependencies.timerClear?.(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.socketGeneration = -1;
    if (!socket) return;
    socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
    try { socket.close(); } catch { /* closing an already-closed socket is not an error */ }
  }

  private fail(kind: GatewayErrorKind): GatewayErrorKind {
    this.lastErrorKind = kind;
    this.dependencies.debug?.(`gateway failure kind=${kind}`);
    return kind;
  }

  private setState(state: GatewayConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.hooks.onStatusChanged?.();
  }
}

function parseJson(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }

export function classifyStatus(status: number): GatewayErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server";
  return "client";
}

/** HTTPS → WSS, HTTP → WS, so a local `wrangler dev` endpoint still works. */
export function webSocketBaseUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (/^https:\/\//i.test(trimmed)) return `wss://${trimmed.slice("https://".length)}`;
  if (/^http:\/\//i.test(trimmed)) return `ws://${trimmed.slice("http://".length)}`;
  return trimmed;
}

export function baseUrl(endpoint: string): string { return endpoint.trim().replace(/\/+$/, ""); }
