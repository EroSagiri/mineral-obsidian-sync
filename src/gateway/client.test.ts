import { describe, expect, it } from "vitest";
import { deriveRemoteChangeChannel, isRemoteChangeChannel } from "@mineral/sync-core/channel";
import { remoteIdentity } from "../remote/r2-client";
import { resolveGatewayConfig } from "./config";
import { createMemoryGatewayCursorStore } from "./cursor-store";
import { GatewayClient } from "./client";
import { gatewayConnectionConfig, type GatewaySettings } from "./types";
import { FakeClock, FakeGatewayTransport, FakeSocketFactory, gatewayDependencies } from "./test-support";

/** Drains the microtask chain a ticket exchange and socket open go through. */
const settle = async (): Promise<void> => { for (let index = 0; index < 16; index++) await Promise.resolve(); };

const settings = (overrides: Partial<GatewaySettings> = {}): GatewaySettings => ({ gatewayEnabled: true, gatewayEndpoint: "https://gateway.example.workers.dev", gatewayToken: "token", ...overrides });
const identity = (overrides: Partial<{ endpoint: string; bucket: string; remotePrefix: string }> = {}) => ({ endpoint: "https://account.r2.cloudflarestorage.com", bucket: "vault", remotePrefix: "notes", ...overrides });

describe("channel derivation", () => {  it("derives one stable 43-character channel for one namespace", async () => {
    const channel = await deriveRemoteChangeChannel(identity());
    expect(channel).toHaveLength(43);
    expect(isRemoteChangeChannel(channel)).toBe(true);
  });

  it("matches the sync-core canonical vector, so plugin and Gateway agree by construction", async () => {
    await expect(deriveRemoteChangeChannel(identity())).resolves.toBe("D3BD_N3xF3hBqgXAmhjUGvKbiwEYzQlM34Y-ShCa8vY");
  });

  it("derives from the same normalized identity the previous-state baseline uses", async () => {
    // This is the property that keeps Windows, Android, and any future Vault writer on one channel:
    // the channel input is `remoteIdentity()`, not a re-normalization invented for the Gateway.
    const fromSettings = remoteIdentity({ endpoint: "https://account.r2.cloudflarestorage.com/", bucket: "vault", remotePrefix: "/notes/" } as never);
    const channel = await deriveRemoteChangeChannel({ endpoint: fromSettings.endpoint, bucket: fromSettings.bucket, remotePrefix: fromSettings.remotePrefix });
    await expect(deriveRemoteChangeChannel(identity())).resolves.toBe(channel);
  });

  it("separates bucket, prefix, endpoint, and empty-prefix namespaces", async () => {
    const base = await deriveRemoteChangeChannel(identity());
    const others = await Promise.all([
      deriveRemoteChangeChannel(identity({ bucket: "other" })),
      deriveRemoteChangeChannel(identity({ remotePrefix: "other" })),
      deriveRemoteChangeChannel(identity({ remotePrefix: "" })),
      deriveRemoteChangeChannel(identity({ endpoint: "https://other.r2.cloudflarestorage.com" })),
    ]);
    for (const channel of others) expect(channel).not.toBe(base);
  });
});

describe("gateway configuration", () => {
  it("disables cleanly when the Gateway is off", async () => {
    await expect(resolveGatewayConfig(settings({ gatewayEnabled: false }), identity())).resolves.toEqual({ kind: "disabled" });
  });

  it("reports missing, invalid, and unusable configuration without throwing", async () => {
    await expect(resolveGatewayConfig(settings({ gatewayEndpoint: "" }), identity())).resolves.toEqual({ kind: "misconfigured", reason: "endpoint-missing" });
    await expect(resolveGatewayConfig(settings({ gatewayEndpoint: "not a url" }), identity())).resolves.toEqual({ kind: "misconfigured", reason: "endpoint-invalid" });
    await expect(resolveGatewayConfig(settings({ gatewayToken: "" }), identity())).resolves.toEqual({ kind: "misconfigured", reason: "token-missing" });
    await expect(resolveGatewayConfig(settings(), identity({ endpoint: "" }))).resolves.toEqual({ kind: "misconfigured", reason: "identity-missing" });
  });

  it("returns a ready channel only for a complete configuration", async () => {
    const resolved = await resolveGatewayConfig(settings(), identity());
    expect(resolved.kind).toBe("ready");
    if (resolved.kind === "ready") expect(isRemoteChangeChannel(resolved.channel)).toBe(true);
  });
});

describe("gateway client lifecycle and cursors", () => {
  function setup(cursor = createMemoryGatewayCursorStore()) {
    const transport = new FakeGatewayTransport();
    const sockets = new FakeSocketFactory();
    const clock = new FakeClock();
    const announced: string[] = [];
    const client = new GatewayClient(() => gatewayConnectionConfig(settings()), transport, cursor, { onAnnounced: (generation) => announced.push(generation) }, gatewayDependencies(sockets, clock));
    return { client, transport, sockets, clock, cursor, announced };
  }

  it("connects with a ticket only, and never places the long-lived token in the URL", async () => {
    const { client, transport, sockets } = setup();
    await client.start("A".repeat(43));
    expect(transport.count("ticket")).toBe(1);
    expect(sockets.last.url).toContain("/v1/channels/" + "A".repeat(43) + "/subscribe");
    expect(sockets.last.url).toContain("ticket=");
    expect(sockets.last.url).not.toContain(settings().gatewayToken);
    expect(sockets.last.url.startsWith("wss://")).toBe(true);
    // The bearer token still travels in the header of the ticket exchange itself.
    expect(transport.requests[0].token).toBe(settings().gatewayToken);
  });

  it("does not request reconciliation for an unchanged snapshot, and does for a newer one", async () => {
    const cursor = createMemoryGatewayCursorStore({ ["A".repeat(43)]: { highestAnnouncedGeneration: "10", lastReconciledGeneration: "10" } });
    const { client, sockets } = setup(cursor);
    await client.start("A".repeat(43));
    sockets.last.open();
    sockets.last.emit({ type: "current-generation", generation: "10" });
    expect(client.hasPending()).toBe(false);

    const newer = setup(createMemoryGatewayCursorStore({ ["A".repeat(43)]: { highestAnnouncedGeneration: "10", lastReconciledGeneration: "10" } }));
    await newer.client.start("A".repeat(43));
    newer.sockets.last.open();
    newer.sockets.last.emit({ type: "current-generation", generation: "15" });
    expect(newer.client.highestAnnounced()).toBe("15");
    expect(newer.client.hasPending()).toBe(true);
    expect(newer.announced).toEqual(["15"]);
  });

  it("never advances the confirmed cursor from a socket frame, only from the scheduler", async () => {
    const { client, sockets } = setup();
    await client.start("A".repeat(43));
    sockets.last.open();
    sockets.last.emit({ type: "remote-dirty", generation: "11" });
    expect(client.lastReconciled()).toBe("0");
    expect(client.hasPending()).toBe(true);
    await client.confirmReconciled("11");
    expect(client.lastReconciled()).toBe("11");
    expect(client.hasPending()).toBe(false);
  });

  it("persists the confirmed cursor per channel and never lets a channel inherit another's", async () => {
    const cursor = createMemoryGatewayCursorStore();
    const first = setup(cursor);
    await first.client.start("A".repeat(43));
    first.sockets.last.open();
    first.sockets.last.emit({ type: "remote-dirty", generation: "10" });
    await first.client.confirmReconciled("10");
    expect(cursor.entries.get("A".repeat(43))).toEqual({ highestAnnouncedGeneration: "10", lastReconciledGeneration: "10" });

    // Switching prefix derives a different channel, whose cursor must start empty.
    const second = setup(cursor);
    await second.client.start("B".repeat(43));
    expect(second.client.lastReconciled()).toBe("0");
    expect(second.client.hasPending()).toBe(false);
  });

  it("drops malformed frames without touching the cursor", async () => {
    const { client, sockets } = setup();
    await client.start("A".repeat(43));
    sockets.last.open();
    for (const payload of ["not json", JSON.stringify({ type: "remote-dirty", generation: 11 }), JSON.stringify({ type: "delete", generation: "5" }), JSON.stringify({ type: "remote-dirty", generation: "-1" }), JSON.stringify({ type: "remote-dirty", generation: "1", path: "x.md" })]) sockets.last.emit(payload);
    expect(client.highestAnnounced()).toBe("0");
    expect(client.hasPending()).toBe(false);
    expect(client.diagnostics().state).toBe("connected");
  });

  it("closes the socket and cancels the reconnect timer while hidden, then reconnects on resume", async () => {
    const { client, sockets, clock } = setup();
    await client.start("A".repeat(43));
    sockets.last.open();
    client.setVisible(false);
    expect(sockets.last.closed).toBe(true);
    expect(client.diagnostics().state).toBe("disabled");
    clock.advance(60_000);
    expect(sockets.sockets).toHaveLength(1);

    client.setVisible(true);
    await settle();
    expect(sockets.sockets.length).toBe(2);
    expect(clock.pending()).toBe(0);
  });

  it("backs off with a bounded schedule and resets it after a successful open", async () => {
    const { client, transport, sockets, clock } = setup();
    transport.respond(async (request) => request.url.endsWith("/ticket") ? { status: 500, text: "" } : { status: 200, text: JSON.stringify({ generation: "0" }) });
    await client.start("A".repeat(43));
    expect(client.diagnostics().state).toBe("backoff");
    expect(clock.delays()).toEqual([1000]);

    transport.respond(async (request) => request.url.endsWith("/ticket") ? { status: 200, text: JSON.stringify({ protocol: 1, ticket: "t", expiresAt: 1 }) } : { status: 200, text: JSON.stringify({ generation: "0" }) });
    clock.advance(1000);
    await settle();
    sockets.last.open();
    expect(client.diagnostics().state).toBe("connected");
    expect(client.diagnostics().reconnectAttempt).toBe(0);
  });

  it("stops permanently on unload and ignores late frames and timers", async () => {
    const { client, sockets, clock } = setup();
    await client.start("A".repeat(43));
    sockets.last.open();
    client.stop();
    expect(client.diagnostics().state).toBe("stopped");
    // A frame that arrives after unload must not move the cursor.
    sockets.last.emit({ type: "remote-dirty", generation: "9" });
    expect(client.highestAnnounced()).toBe("0");
    clock.advance(60_000);
    expect(sockets.sockets.length).toBe(1);
  });

  it("fences a late frame from a superseded channel so it cannot steer the new one", async () => {
    const cursor = createMemoryGatewayCursorStore();
    const { client, sockets } = setup(cursor);
    await client.start("A".repeat(43));
    const oldSocket = sockets.last;
    oldSocket.open();
    await client.reconfigure("B".repeat(43));
    // The old socket's handlers were detached during the fence.
    oldSocket.emit({ type: "remote-dirty", generation: "42" });
    expect(client.highestAnnounced()).toBe("0");
    expect(client.currentChannel()).toBe("B".repeat(43));
  });

  it("reports a reconnect snapshot as the new pending generation without replaying every step", async () => {
    const cursor = createMemoryGatewayCursorStore({ ["A".repeat(43)]: { highestAnnouncedGeneration: "20", lastReconciledGeneration: "20" } });
    const { client, sockets } = setup(cursor);
    await client.start("A".repeat(43));
    sockets.last.open();
    // A disconnect is not an error and does not change the cursor.
    sockets.last.drop();
    expect(client.hasPending()).toBe(false);
    // Reconnecting re-reads the snapshot; the cursor comes from storage, so nothing is replayed.
    await client.start("A".repeat(43));
    sockets.last.open();
    sockets.last.emit({ type: "current-generation", generation: "25" });
    expect(client.highestAnnounced()).toBe("25");
    expect(client.lastReconciled()).toBe("20");
    expect(client.hasPending()).toBe(true);
    // No need to replay 21..24: one comparison is enough.
    expect(client.diagnostics().remotePending).toBe(true);
  });

  it("classifies control-plane failures and leaves the cursor untouched", async () => {
    const transport = new FakeGatewayTransport();
    const sockets = new FakeSocketFactory();
    const clock = new FakeClock();
    const client = new GatewayClient(() => gatewayConnectionConfig(settings()), transport, createMemoryGatewayCursorStore(), { onAnnounced: () => {} }, gatewayDependencies(sockets, clock));
    await client.start("A".repeat(43));

    transport.respond(async () => ({ status: 401, text: "" }));
    await expect(client.readGeneration()).resolves.toEqual({ ok: false, kind: "auth" });
    await expect(client.markRemoteDirty()).resolves.toEqual({ ok: false, kind: "auth" });
    transport.respond(async () => ({ status: 503, text: "" }));
    await expect(client.readGeneration()).resolves.toEqual({ ok: false, kind: "server" });
    transport.respond(async () => ({ status: 404, text: "" }));
    await expect(client.readGeneration()).resolves.toEqual({ ok: false, kind: "client" });
    transport.respond(async () => ({ status: 200, text: "<html>" }));
    await expect(client.readGeneration()).resolves.toEqual({ ok: false, kind: "malformed" });
    expect(client.highestAnnounced()).toBe("0");
    expect(client.hasPending()).toBe(false);
  });

  it("treats our own successful mark as an announcement, never as a confirmation", async () => {
    const transport = new FakeGatewayTransport();
    const sockets = new FakeSocketFactory();
    const clock = new FakeClock();
    const client = new GatewayClient(() => gatewayConnectionConfig(settings()), transport, createMemoryGatewayCursorStore(), { onAnnounced: () => {} }, gatewayDependencies(sockets, clock));
    await client.start("A".repeat(43));
    transport.respondGeneration("7", "7");
    await expect(client.markRemoteDirty()).resolves.toEqual({ ok: true, generation: "7" });
    expect(client.highestAnnounced()).toBe("7");
    expect(client.lastReconciled()).toBe("0");
    expect(client.hasPending()).toBe(true);
  });
});
