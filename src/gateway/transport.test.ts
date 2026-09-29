import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRequestUrlHandler, setRequestUrlHandler } from "../../test/obsidian";
import { GatewayRequestError } from "./errors";
import { RequestUrlGatewayTransport, type GatewayHttpRequest } from "./transport";

/**
 * The one class every Gateway call goes through, on every platform.
 *
 * The cold control plane, the hot HTTP surface, and the on-device self-test all construct it, and its
 * primitive is Obsidian's `requestUrl` — the only HTTP path that works identically on desktop and on
 * Android. That makes three of its behaviours load-bearing rather than incidental:
 *
 * - a non-2xx answer is a *result* the caller classifies (`throw: false`), because a 401 must reach the
 *   client's own state machine and not arrive as an opaque rejection;
 * - a timeout is a distinct, retryable class, and the timer must not survive the call;
 * - the token travels in a header, never in the URL.
 */

const request = (overrides: Partial<GatewayHttpRequest> = {}): GatewayHttpRequest => ({
  url: "https://gateway.test/v1/channels/c",
  method: "GET",
  headers: { "content-type": "application/json" },
  token: "gateway-token",
  timeoutMs: 1_000,
  ...overrides,
});

// The transport reaches for `window.setTimeout` because that is what Obsidian provides; tests run in
// Node, so the global is installed here rather than changing production code for the test env.
beforeEach(() => { (globalThis as Record<string, unknown>).window = globalThis; });
afterEach(() => { resetRequestUrlHandler(); vi.useRealTimers(); });

describe("the Gateway HTTP transport", () => {
  it("sends the bearer token in a header and leaves the caller's headers intact", async () => {
    const seen: Array<Record<string, unknown>> = [];
    setRequestUrlHandler(async (mock) => {
      seen.push(mock as unknown as Record<string, unknown>);
      return { status: 200, text: "{}", headers: {}, arrayBuffer: new ArrayBuffer(0), json: {} };
    });

    await new RequestUrlGatewayTransport().send(request({ method: "POST", body: "{\"a\":1}" }));

    expect(seen).toHaveLength(1);
    expect(seen[0].headers).toEqual({ "content-type": "application/json", Authorization: "Bearer gateway-token" });
    expect(seen[0].body).toBe("{\"a\":1}");
    // The token must not be anywhere a log line or a proxy could pick it up.
    expect(String(seen[0].url)).not.toContain("gateway-token");
    // `throw: false` is what lets a 401 come back as a status instead of an exception.
    expect(seen[0].throw).toBe(false);
  });

  it("returns a failure status as a result instead of throwing it", async () => {
    setRequestUrlHandler(async () => ({ status: 401, text: "{\"error\":\"unauthorized\"}", headers: {}, arrayBuffer: new ArrayBuffer(0), json: {} }));

    await expect(new RequestUrlGatewayTransport().send(request())).resolves.toEqual({ status: 401, text: "{\"error\":\"unauthorized\"}" });
  });

  it("classifies a transport failure as retryable rather than as a result", async () => {
    setRequestUrlHandler(async () => { throw new Error("socket hang up"); });

    const failure = await new RequestUrlGatewayTransport().send(request()).catch(error => error);
    expect(failure).toBeInstanceOf(GatewayRequestError);
    expect((failure as GatewayRequestError).kind).toBe("transport");
  });

  it("times out a hung request, clears its timer, and says which failure it was", async () => {
    vi.useFakeTimers();
    // A request that never settles, which is what a black-holed connection looks like on a phone.
    setRequestUrlHandler(() => new Promise(() => {}));
    const spy = vi.spyOn(globalThis, "clearTimeout");

    const pending = new RequestUrlGatewayTransport().send(request({ timeoutMs: 250 })).catch(error => error);
    await vi.advanceTimersByTimeAsync(250);
    const failure = await pending;

    expect(failure).toBeInstanceOf(GatewayRequestError);
    expect((failure as GatewayRequestError).kind).toBe("timeout");
    // A leaked timer would keep a scheduler cycle alive after it decided to give up.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

