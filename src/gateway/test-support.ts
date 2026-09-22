import type { GatewayTransport, GatewayHttpRequest, GatewayHttpResponse } from "./transport";
import { GatewayRequestError } from "./errors";
import type { GatewaySocketLike, GatewayClientDependencies } from "./client";
import type { SchedulerRemoteChange } from "../scheduler/types";

/** A scripted Gateway HTTP transport. No real network, no real time. */
export class FakeGatewayTransport implements GatewayTransport {
  readonly requests: GatewayHttpRequest[] = [];
  private handler: (request: GatewayHttpRequest) => Promise<GatewayHttpResponse> = async (request) => {
    if (request.url.endsWith("/ticket")) return { status: 200, text: JSON.stringify({ protocol: 1, ticket: "ticket-1", expiresAt: Date.now() + 60_000 }) };
    if (request.method === "POST") return { status: 200, text: JSON.stringify({ generation: "1" }) };
    return { status: 200, text: JSON.stringify({ generation: "0" }) };
  };

  respond(handler: (request: GatewayHttpRequest) => Promise<GatewayHttpResponse>): void { this.handler = handler; }
  /** Serves `generation` for reads and the next generation for marks. */
  respondGeneration(generation: string, next = "999"): void {
    this.respond(async (request) => ({ status: 200, text: JSON.stringify({ generation: request.method === "POST" && request.url.endsWith("/dirty") ? next : generation }) }));
  }

  async send(request: GatewayHttpRequest): Promise<GatewayHttpResponse> {
    this.requests.push(request);
    return this.handler(request);
  }

  count(kind: "dirty" | "read" | "ticket"): number {
    return this.requests.filter((request) => kind === "dirty" ? request.url.endsWith("/dirty") : kind === "read" ? request.method === "GET" : request.url.endsWith("/ticket")).length;
  }
}

/** A scripted WebSocket. `open()` and `emit()` let a test drive the lifecycle deterministically. */
export class FakeSocket implements GatewaySocketLike {
  readyState = 0;
  closed = false;
  readonly sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
  /** Simulates the server accepting the connection. */
  open(): void { this.readyState = 1; this.onopen?.(new Event("open")); }
  /** Simulates a valid or malformed frame arriving. */
  emit(payload: unknown): void {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.onmessage?.({ data } as MessageEvent);
  }
  /** Simulates the transport dropping the connection. */
  drop(): void { this.readyState = 3; this.onclose?.(new CloseEvent("close")); }
}

export class FakeSocketFactory {
  readonly sockets: FakeSocket[] = [];
  open(url: string): GatewaySocketLike {
    const socket = new FakeSocket(url);
    this.sockets.push(socket);
    return socket;
  }
  get last(): FakeSocket { return this.sockets[this.sockets.length - 1]; }
}

export class FakeClock {
  private time = 1_700_000_000_000;
  private nextId = 1;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  now = (): number => this.time;
  set = (delay: number, callback: () => void): unknown => { const id = this.nextId++; this.timers.set(id, { at: this.time + delay, callback }); return id; };
  clear = (handle: unknown): void => { this.timers.delete(handle as number); };
  /** Fires every timer due within `delay` and advances the clock, repeatably. */
  advance(delay: number): void {
    const target = this.time + delay;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      const [id, timer] = due[0];
      this.timers.delete(id);
      this.time = timer.at;
      timer.callback();
    }
    this.time = target;
  }
  pending(): number { return this.timers.size; }
  delays(): number[] { return [...this.timers.values()].map((timer) => timer.at - this.time); }
}

export function gatewayDependencies(factory: FakeSocketFactory, clock: FakeClock): GatewayClientDependencies {
  return { openSocket: (url) => factory.open(url), now: clock.now, timerSet: clock.set, timerClear: clock.clear };
}

/**
 * A scripted control plane for scheduler tests. It mirrors the real client's contract exactly: only
 * the scheduler advances the confirmed cursor, and only through `confirmReconciled`.
 */
export class FakeRemoteChange implements SchedulerRemoteChange {
  announced = "0";
  reconciled = "0";
  confirmCalls: string[] = [];
  notifyCalls = 0;
  private scripted: string[] = [];
  readFailure: string | undefined;
  notifyFailure: string | undefined;

  /** Scripts the sequence of generations returned by successive reads. */
  script(...generations: string[]): void { this.scripted = [...generations]; }
  announce(generation: string): void { if (BigInt(generation) > BigInt(this.announced)) this.announced = generation; }
  hasPending(): boolean { return BigInt(this.announced) > BigInt(this.reconciled); }
  canApplyIncrementally(generation: string): boolean { return BigInt(generation) === BigInt(this.reconciled) + 1n; }
  async readGeneration(): Promise<{ ok: true; generation: string } | { ok: false; kind: string }> {
    if (this.readFailure) return { ok: false, kind: this.readFailure };
    const next = this.scripted.length ? this.scripted.shift()! : this.announced;
    return { ok: true, generation: next };
  }
  async confirmReconciled(generation: string): Promise<void> {
    this.confirmCalls.push(generation);
    if (BigInt(generation) > BigInt(this.reconciled)) this.reconciled = generation;
  }
  async notifyRemoteDirty(): Promise<{ ok: true; generation: string } | { ok: false; kind: string }> {
    this.notifyCalls++;
    if (this.notifyFailure) return { ok: false, kind: this.notifyFailure };
    // The real Hub advances its generation, but that advance is announced to this client
    // asynchronously over the socket. A test can script that announcement with `announce()`.
    return { ok: true, generation: this.announced };
  }
}
