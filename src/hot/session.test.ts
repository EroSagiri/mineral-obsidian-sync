import { describe, expect, it } from "vitest";
import type { HotServerMessage } from "@mineral/sync-core/hot-protocol";
import * as Y from "yjs";
import { encodeHotPayload, hotContentHash } from "@mineral/sync-core/hot-protocol";
import { HotGatewayClient, type HotHttpRequest, type HotHttpResponse, type HotSocket } from "./client";
import { HotDocumentSession, type HotDocumentPort } from "./session";
import { MemoryHotStateStore } from "./store";
import { outboxKey, type HotSessionStatus } from "./types";

/**
 * The hot session's state machine, driven frame by frame.
 *
 * These tests are about durability, not about Yjs: the CRDT is replaced by a port that records what it
 * was told to apply. What is asserted is that no acknowledgement is trusted before the edit behind it
 * is durable, that a rejection is classified rather than swallowed, and that a handoff either completes
 * or leaves a fence up.
 */

const CHANNEL = "C".repeat(43);
const PATH = "notes/hot.md";
const DOCUMENT = "AbCdEfGhIjKlMnOpQrStUv";

class FakeSocket implements HotSocket {
  readonly sent: string[] = [];
  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  closed = false;

  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.closeHandler?.(); }
  onMessage(handler: (data: string) => void): void { this.messageHandler = handler; }
  onClose(handler: () => void): void { this.closeHandler = handler; }

  emit(frame: Record<string, unknown>): void { this.messageHandler?.(JSON.stringify(frame)); }
  frames(): Record<string, unknown>[] { return this.sent.map(entry => JSON.parse(entry) as Record<string, unknown>); }
  lastFrame(): Record<string, unknown> { return this.frames().at(-1)!; }
}

class FakeDocument implements HotDocumentPort {
  appliedStates: string[] = [];
  appliedUpdates: string[] = [];
  content = "";

  applyState(state: string): void { this.appliedStates.push(state); }
  applyRemote(update: string): void { this.appliedUpdates.push(update); }
  text(): string { return this.content; }
}

function harness(options: {
  release?: (body: Record<string, unknown>) => { status: number; text: string };
  acquireBody?: Record<string, unknown>;
  acquire?: (count: number) => Promise<HotHttpResponse>;
  storeFault?: unknown;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
} = {}) {
  const requests: HotHttpRequest[] = [];
  const sockets: FakeSocket[] = [];
  let acquireCount = 0;
  const transport = async (request: HotHttpRequest): Promise<HotHttpResponse> => {
    requests.push(request);
    if (request.url.endsWith("/hot/release")) {
      return options.release?.(JSON.parse(request.body ?? "{}") as Record<string, unknown>) ?? { status: 200, text: JSON.stringify({ protocol: 1, outcome: "released", remainingClients: 0 }) };
    }
    if (request.url.endsWith("/hot/acquire")) {
      acquireCount += 1;
      if (options.acquire) return options.acquire(acquireCount);
      return {
        status: 200,
        text: JSON.stringify(options.acquireBody ?? {
          protocol: 1,
          outcome: "created",
          canonicalPath: PATH,
          binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 },
          remote: null,
          identity: { documentId: DOCUMENT, epoch: 1 },
          serverRevision: 0,
          latestCheckpointedRevision: 0,
          roomState: "active",
          sessionTicket: "ticket-1",
        }),
      };
    }
    return { status: 200, text: "{}" };
  };
  const client = new HotGatewayClient(
    { endpoint: "https://gateway.test", token: "token", channel: CHANNEL },
    transport,
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  );
  const store = new MemoryHotStateStore();
  store.putOutboxFault = options.storeFault ?? null;
  const doc = new FakeDocument();
  const statuses: HotSessionStatus[] = [];
  const conflicts: string[] = [];
  let reconnectId = 0;
  const session = new HotDocumentSession({
    client,
    store,
    doc,
    clientId: "device-a",
    canonicalPath: PATH,
    events: { onStatus: status => statuses.push(status), onConflict: reason => conflicts.push(reason) },
    receiptTimeoutMs: 60,
    drainTimeoutMs: 200,
    drainStepMs: 5,
    ...(options.reconnectInitialDelayMs !== undefined ? { reconnectInitialDelayMs: options.reconnectInitialDelayMs } : {}),
    ...(options.reconnectMaxDelayMs !== undefined ? { reconnectMaxDelayMs: options.reconnectMaxDelayMs } : {}),
    nextReconnectOperationId: () => {
      reconnectId += 1;
      return `reconnect-${reconnectId}`;
    },
  });
  return { session, store, doc, sockets, requests, statuses, conflicts };
}

/** A real encoded CRDT state: a welcome whose payload the CRDT cannot read is a different test. */
function welcomeState(): string {
  const doc = new Y.Doc();
  doc.getText("markdown").insert(0, "");
  return encodeHotPayload(Y.encodeStateAsUpdate(doc));
}

const welcomeFrame = { protocol: 1, type: "welcome", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, state: "active", serverRevision: 0, latestCheckpointedRevision: 0, crdtState: welcomeState(), pendingSave: false };
const ackFrame = (revision: number, id: string, duplicate = false) => ({ protocol: 1, type: "ack", documentId: DOCUMENT, epoch: 1, clientOperationId: id, serverRevision: revision, duplicate });

describe("hot session durability", () => {
  it("does not let welcome overwrite a synchronous editor freeze or accept later updates", async () => {
    const { session, doc, store, statuses } = harness();
    await session.start({ local: null, operationId: "start" });
    let frozen!: Promise<void>;
    doc.applyState = () => { frozen = session.freeze("editor-document-divergence"); };
    await session.handleFrame(welcomeFrame as HotServerMessage);
    await frozen;
    expect(session.status).toBe("conflict");
    expect((await store.loadSessions())[0]?.status).toBe("conflict");
    const count = statuses.length;
    await session.handleFrame(welcomeFrame as HotServerMessage);
    await session.handleFrame({ protocol: 1, type: "operation", documentId: DOCUMENT, epoch: 1,
      clientId: "other-device", clientOperationId: "other-edit", parentRevision: 0, serverRevision: 1, update: "ignored" });
    expect(session.status).toBe("conflict");
    expect(statuses.length).toBe(count);
    expect(doc.appliedUpdates).toEqual([]);
  });
  it("closes the raw socket on plugin shutdown without deleting the resumable record", async () => {
    const { session, store, sockets } = harness({ reconnectInitialDelayMs: 1 });
    await session.start({ local: null, operationId: "acquire-1" });
    expect(sockets).toHaveLength(1);

    session.shutdown();

    expect(sockets[0].closed).toBe(true);
    expect(await store.loadSessions()).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(sockets, "an unloaded plugin instance must never reconnect").toHaveLength(1);
  });

  it("persists an edit before sending it, and clears it only on the acknowledgement", async () => {
    const { session, store, sockets } = harness();
    await session.start({ local: null, operationId: "acquire-1" });
    expect(sockets).toHaveLength(1);
    sockets[0].emit(welcomeFrame);
    await new Promise(resolve => setTimeout(resolve, 0));

    await session.applyLocalUpdate(encodeHotPayload(new Uint8Array([9])), "op-1");
    const stored = await store.loadOutbox();
    expect(stored).toHaveLength(1);
    expect(stored[0].key).toBe(outboxKey(DOCUMENT, 1, "op-1"));
    expect(sockets[0].lastFrame()).toMatchObject({ type: "operation", clientOperationId: "op-1", epoch: 1 });

    await session.handleFrame(ackFrame(1, "op-1") as never);
    expect(await store.loadOutbox()).toHaveLength(0);
    expect(session.session?.lastAcceptedRevision).toBe(1);
    expect(session.session?.pendingSave).toBe(true);
    expect(session.pending()).toHaveLength(0);
  });

  it("classifies a stale-epoch rejection instead of retrying it", async () => {
    const { session, sockets, conflicts } = harness();
    await session.start({ local: null, operationId: "acquire-1" });
    sockets[0].emit(welcomeFrame);
    await new Promise(resolve => setTimeout(resolve, 0));
    await session.applyLocalUpdate(encodeHotPayload(new Uint8Array([9])), "op-1");
    await session.handleFrame({ protocol: 1, type: "reject", documentId: DOCUMENT, epoch: 1, clientOperationId: "op-1", reason: "stale-epoch" } as never);
    expect(session.status).toBe("conflict");
    expect(conflicts).toContain("stale-epoch");
    // A rejection is not an acknowledgement: the old-epoch operation remains as evidence for the
    // conflict resolver instead of being silently discarded.
    expect(session.pending().map(entry => entry.clientOperationId)).toEqual(["op-1"]);
  });

  it("applies remote updates verbatim and ignores its own acknowledgements' revisions", async () => {
    const { session, doc, sockets } = harness();
    await session.start({ local: null, operationId: "acquire-1" });
    sockets[0].emit(welcomeFrame);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(doc.appliedStates).toHaveLength(1);
    await session.handleFrame({ protocol: 1, type: "operation", documentId: DOCUMENT, epoch: 1, clientId: "device-b", clientOperationId: "x", update: encodeHotPayload(new Uint8Array([7])), parentRevision: 0, serverRevision: 4 } as never);
    expect(doc.appliedUpdates).toHaveLength(1);
    expect(session.session?.lastAcceptedRevision).toBe(0);
  });

  it("ignores an operation echoed through another socket with the same client id", async () => {
    const { session, doc, sockets } = harness();
    await session.start({ local: null, operationId: "acquire-1" });
    sockets[0].emit(welcomeFrame);
    await new Promise(resolve => setTimeout(resolve, 0));

    await session.handleFrame({ protocol: 1, type: "operation", documentId: DOCUMENT, epoch: 1, clientId: "device-a", clientOperationId: "own-op", update: encodeHotPayload(new Uint8Array([7])), parentRevision: 0, serverRevision: 1 } as never);

    expect(doc.appliedUpdates).toHaveLength(0);
  });

  it("re-sends unacknowledged work after a resume, and drops rows from a retired epoch", async () => {
    const { session, store, sockets } = harness();
    await session.start({ local: null, operationId: "acquire-1" });
    sockets[0].emit(welcomeFrame);
    await new Promise(resolve => setTimeout(resolve, 0));
    await session.applyLocalUpdate(encodeHotPayload(new Uint8Array([1])), "op-1");
    await store.putOutbox({ key: outboxKey(DOCUMENT, 9, "old"), canonicalPath: PATH, documentId: DOCUMENT, epoch: 9, clientId: "device-a", clientOperationId: "old", update: encodeHotPayload(new Uint8Array([2])), createdAt: 1, attempts: 0 });

    const restored = harness();
    await restored.store.putSession(session.session!);
    await restored.store.putOutbox({ key: outboxKey(DOCUMENT, 1, "op-1"), canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, clientId: "device-a", clientOperationId: "op-1", update: encodeHotPayload(new Uint8Array([1])), createdAt: 1, attempts: 0 });
    await restored.store.putOutbox({ key: outboxKey(DOCUMENT, 9, "old"), canonicalPath: PATH, documentId: DOCUMENT, epoch: 9, clientId: "device-a", clientOperationId: "old", update: encodeHotPayload(new Uint8Array([2])), createdAt: 1, attempts: 0 });
    const record = await restored.session.restore();
    expect(record?.documentId).toBe(DOCUMENT);
    expect(restored.session.pending().map(entry => entry.clientOperationId)).toEqual(["op-1"]);
    await restored.session.resume("resume-1");
    restored.sockets[0].emit(welcomeFrame);
    restored.sockets[0].emit({ ...welcomeFrame, epoch: 1, latestCheckpointedRevision: 0 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(restored.sockets[0].frames().some(frame => frame.type === "operation" && frame.clientOperationId === "op-1")).toBe(true);
    expect((await restored.store.loadOutbox()).map(entry => entry.key)).toEqual([outboxKey(DOCUMENT, 1, "op-1")]);
  });

  it("keeps an oversized edit and freezes the session instead of retrying a permanent rejection", async () => {
    /**
     * `too-large` is a verdict on the *packet*, not on the document identity. The edit still belongs
     * to the user, the Y.Doc has already absorbed it, and dropping the row here would leave the local
     * CRDT ahead of the server forever — exactly the silent fork the mobile rollout exposed.
     */
    const { session, sockets, store } = harness();
    await session.start({ local: null, operationId: "acquire-1" });
    sockets[0].emit(welcomeFrame);
    await new Promise(resolve => setTimeout(resolve, 0));
    await session.applyLocalUpdate(encodeHotPayload(new Uint8Array([1])), "op-1");
    await session.handleFrame({ protocol: 1, type: "reject", documentId: DOCUMENT, epoch: 1, clientOperationId: "op-1", reason: "too-large" } as never);

    expect(session.pending().map(entry => entry.clientOperationId)).toEqual(["op-1"]);
    expect((await store.loadOutbox()).map(entry => entry.clientOperationId)).toEqual(["op-1"]);
    expect(session.status).toBe("conflict");
  });

  it("keeps the volatile edit, freezes the path, and surfaces a durable-write failure", async () => {
    /**
     * The contract is "persist before send". A throw from `putOutbox` previously left the entry in the
     * map and silently failed the whole plugin: a transient IndexedDB hiccup sent a message the server
     * never saw, and the next `flush` re-sent it from a row whose durable half was missing.
     */
    const { session, sockets } = harness({ storeFault: new Error("indexeddb-unavailable") });

    await session.start({ local: null, operationId: "acquire-1" });
    sockets[0].emit(welcomeFrame);
    await new Promise(resolve => setTimeout(resolve, 0));

    await expect(session.applyLocalUpdate(encodeHotPayload(new Uint8Array([1])), "op-1")).rejects.toThrow("indexeddb-unavailable");
    expect(session.pending().map(entry => entry.clientOperationId)).toEqual(["op-1"]);
    expect(session.status).toBe("conflict");
    expect(sockets[0].frames().filter(frame => frame.type === "operation")).toEqual([]);
  });

  it("reconnects after the socket drops unexpectedly and replays pending work", async () => {
    /**
     * The earlier behaviour marked the session `disconnected` and stopped there. A subsequent
     * `open()` saw the existing record and returned without re-acquiring, so every local edit from
     * then on stayed in the Y.Doc and outbox without ever reaching the room — and the handoff that
     * eventually fired was doomed for a reason that looked like "this device contributed nothing".
     * Reconnect must invoke `resume()` and bring the outbox with it.
     */
    const harnessOptions = {
      reconnectInitialDelayMs: 5,
      reconnectMaxDelayMs: 20,
    };
    const { session, sockets, store } = harness(harnessOptions);

    await session.start({ local: null, operationId: "acquire-1" });
    sockets[0].emit(welcomeFrame);
    await new Promise(resolve => setTimeout(resolve, 0));
    await session.applyLocalUpdate(encodeHotPayload(new Uint8Array([1])), "op-1");

    // The first socket dies without an explicit close.
    sockets[0].close();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(session.status).toBe("disconnected");

    // Reconnect fires, opens a second socket, receives a fresh welcome.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sockets).toHaveLength(2);
    sockets[1].emit(welcomeFrame);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(session.status).toBe("hot");
    // The pending edit was replayed on the new socket.
    expect(sockets[1].frames().some(frame => frame.type === "operation" && frame.clientOperationId === "op-1")).toBe(true);
    expect((await store.loadOutbox()).map(entry => entry.clientOperationId)).toEqual(["op-1"]);
  });

  it("gives up reconnecting when the server answers with a verdict instead of a socket", async () => {
    /**
     * The reconnect loop is for *transport* failure: the server refusing with a conflict or rejection
     * is the room's verdict and must end the loop, not be retried forever. A session whose first
     * acquire returned a normal "created" outcome and whose second (reconnect) acquire returned a
     * conflict must therefore not open a third socket — the verdict is final for now and the user-
     * facing conflict machinery takes over.
     */
    let acquireCount = 0;
    const requests: HotHttpRequest[] = [];
    const sockets: FakeSocket[] = [];
    const transport = async (request: HotHttpRequest): Promise<HotHttpResponse> => {
      requests.push(request);
      if (request.url.endsWith("/hot/acquire")) {
        acquireCount += 1;
        const body = acquireCount === 1 ? {
          protocol: 1,
          outcome: "created",
          canonicalPath: PATH,
          binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 },
          remote: null,
          identity: { documentId: DOCUMENT, epoch: 1 },
          serverRevision: 0,
          latestCheckpointedRevision: 0,
          roomState: "active",
          sessionTicket: "ticket-1",
        } : {
          protocol: 1,
          outcome: "conflict",
          canonicalPath: PATH,
          binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "conflicted", updatedAt: 1 },
          remote: null,
          reason: "local-remote-mismatch",
          serverRevision: 0,
          latestCheckpointedRevision: 0,
          roomState: "conflicted",
        };
        return { status: 200, text: JSON.stringify(body) };
      }
      return { status: 200, text: "{}" };
    };
    const client = new HotGatewayClient(
      { endpoint: "https://gateway.test", token: "token", channel: CHANNEL },
      transport,
      () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    );
    const store = new MemoryHotStateStore();
    const doc = new FakeDocument();
    const session = new HotDocumentSession({
      client,
      store,
      doc,
      clientId: "device-a",
      canonicalPath: PATH,
      receiptTimeoutMs: 60,
      drainTimeoutMs: 200,
      drainStepMs: 5,
      reconnectInitialDelayMs: 5,
      reconnectMaxDelayMs: 5,
      nextReconnectOperationId: () => "reconnect-1",
    });

    await session.start({ local: null, operationId: "acquire-1" });
    expect(sockets).toHaveLength(1);
    // The first socket drops without an explicit close, triggering the reconnect loop.
    sockets[0].close();
    await new Promise(resolve => setTimeout(resolve, 30));

    // The reconnect loop made exactly one follow-up acquire that the server answered with conflict;
    // because the verdict is final, no new socket was opened (connect is skipped on conflict) and no
    // third acquire was attempted.
    expect(sockets).toHaveLength(1);
    expect(session.status).toBe("conflict");
    expect(acquireCount).toBe(2);
  });

  it("does not resurrect a session when abandon lands during an in-flight reconnect", async () => {
    let releaseReconnect: (() => void) | undefined;
    const acquireBody = {
      protocol: 1,
      outcome: "created",
      canonicalPath: PATH,
      binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 },
      remote: null,
      identity: { documentId: DOCUMENT, epoch: 1 },
      serverRevision: 0,
      latestCheckpointedRevision: 0,
      roomState: "active",
      sessionTicket: "ticket-1",
    };
    const { session, sockets, requests } = harness({
      reconnectInitialDelayMs: 5,
      reconnectMaxDelayMs: 5,
      acquire: async count => {
        if (count === 1) return { status: 200, text: JSON.stringify(acquireBody) };
        await new Promise<void>(resolve => { releaseReconnect = resolve; });
        return { status: 200, text: JSON.stringify({ ...acquireBody, outcome: "joined", sessionTicket: "ticket-2" }) };
      },
    });

    await session.start({ local: null, operationId: "acquire-1" });
    sockets[0].emit(welcomeFrame);
    sockets[0].close();
    for (let attempt = 0; attempt < 20 && !releaseReconnect; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(releaseReconnect).toBeTypeOf("function");

    session.abandon();
    releaseReconnect!();
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(sockets).toHaveLength(1);
    expect(requests.filter(request => request.url.endsWith("/hot/release"))).toHaveLength(1);
  });
});

describe("hot handoff", () => {
  it("completes only when a receipt covers the acknowledged revision and the local bytes match it", async () => {
    const { session, store, sockets } = harness();
    await session.start({ local: null, operationId: "acquire-1" });
    sockets[0].emit(welcomeFrame);
    await new Promise(resolve => setTimeout(resolve, 0));
    await session.handleFrame(ackFrame(1, "op-1") as never);
    const contentHash = await hotContentHash("hello\n");
    await session.handleFrame({ protocol: 1, type: "checkpoint", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, documentRevision: 1, contentHash, r2ETag: "etag-1", commitId: "c1", latestAcceptedRevision: 1, latestCheckpointedRevision: 1, checkpointedAt: 1 } as never);

    const outcome = await session.close({ checkpoint: true, localText: "hello\n", operationId: "release-1" });
    expect(outcome.outcome).toBe("handed-off");
    expect(outcome.receipt?.r2ETag).toBe("etag-1");
    expect(await store.loadHandoffs()).toHaveLength(0);
    expect(session.status).toBe("closed");
  });

  it("stays pending when the local file is not the revision the server saved", async () => {
    const { session, store, sockets } = harness();
    await session.start({ local: null, operationId: "acquire-1" });
    sockets[0].emit(welcomeFrame);
    await new Promise(resolve => setTimeout(resolve, 0));
    await session.handleFrame(ackFrame(1, "op-1") as never);
    await session.handleFrame({ protocol: 1, type: "checkpoint", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, documentRevision: 1, contentHash: await hotContentHash("hello\n"), r2ETag: "etag-1", commitId: "c1", latestAcceptedRevision: 1, latestCheckpointedRevision: 1, checkpointedAt: 1 } as never);

    const outcome = await session.close({ checkpoint: true, localText: "hello\nmore\n", operationId: "release-1" });
    expect(outcome.outcome).toBe("handoff-pending");
    expect(outcome.detail).toBe("content-mismatch");
    const handoffs = await store.loadHandoffs();
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].requiredRevision).toBe(1);
  });

  it("reports saved-but-still-hot when another client keeps the document open", async () => {
    const { session, sockets } = harness({ release: () => ({ status: 200, text: JSON.stringify({ protocol: 1, outcome: "checkpoint-pending", remainingClients: 1 }) }) });
    await session.start({ local: null, operationId: "acquire-1" });
    sockets[0].emit(welcomeFrame);
    await new Promise(resolve => setTimeout(resolve, 0));
    await session.handleFrame(ackFrame(1, "op-1") as never);
    await session.handleFrame({ protocol: 1, type: "checkpoint", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, documentRevision: 1, contentHash: await hotContentHash("hello\n"), r2ETag: "etag-1", commitId: "c1", latestAcceptedRevision: 1, latestCheckpointedRevision: 1, checkpointedAt: 1 } as never);

    const outcome = await session.close({ checkpoint: true, localText: "hello\n", operationId: "release-1" });
    // This device's work is saved — the receipt proves it — but the path is not free, so reporting a
    // completed handoff here would let the cold path race a session it cannot see.
    expect(outcome.outcome).toBe("saved-hot-elsewhere");
    expect(outcome.receipt?.r2ETag).toBe("etag-1");
  });

  it("stays pending when the release fails outright", async () => {
    const { session, sockets } = harness({ release: () => ({ status: 200, text: JSON.stringify({ protocol: 1, outcome: "checkpoint-pending", remainingClients: 0 }) }) });
    await session.start({ local: null, operationId: "acquire-1" });
    sockets[0].emit(welcomeFrame);
    await new Promise(resolve => setTimeout(resolve, 0));
    await session.handleFrame(ackFrame(1, "op-1") as never);
    await session.handleFrame({ protocol: 1, type: "checkpoint", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, documentRevision: 1, contentHash: await hotContentHash("hello\n"), r2ETag: "etag-1", commitId: "c1", latestAcceptedRevision: 1, latestCheckpointedRevision: 1, checkpointedAt: 1 } as never);
    const outcome = await session.close({ checkpoint: true, localText: "hello\n", operationId: "release-1" });
    expect(outcome.outcome).toBe("handoff-pending");
    expect(outcome.detail).toBe("checkpoint-pending");
  });

  it("stays pending when no receipt arrives at all", async () => {
    const { session, sockets } = harness();
    await session.start({ local: null, operationId: "acquire-1" });
    sockets[0].emit(welcomeFrame);
    await new Promise(resolve => setTimeout(resolve, 0));
    await session.handleFrame(ackFrame(3, "op-1") as never);
    const outcome = await session.close({ checkpoint: true, localText: "hello\n", operationId: "release-1" });
    expect(outcome.outcome).toBe("handoff-pending");
    expect(outcome.detail).toBe("no-receipt");
  });

  it("answers a checkpoint request with the receipt that covers the requested revision", async () => {
    const { session, sockets } = harness();
    await session.start({ local: null, operationId: "acquire-1" });
    sockets[0].emit(welcomeFrame);
    await new Promise(resolve => setTimeout(resolve, 0));
    const pending = session.requestCheckpoint(2);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sockets[0].lastFrame()).toMatchObject({ type: "checkpoint-request", upToRevision: 2 });
    // A receipt for an older revision must not satisfy a request for a newer one.
    await session.handleFrame({ protocol: 1, type: "checkpoint", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, documentRevision: 1, contentHash: await hotContentHash("x"), r2ETag: null, commitId: "c1", latestAcceptedRevision: 2, latestCheckpointedRevision: 1, checkpointedAt: 1 } as never);
    await session.handleFrame({ protocol: 1, type: "checkpoint", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, documentRevision: 2, contentHash: await hotContentHash("y"), r2ETag: "etag-2", commitId: "c2", latestAcceptedRevision: 2, latestCheckpointedRevision: 2, checkpointedAt: 2 } as never);
    const receipt = await pending;
    expect(receipt?.documentRevision).toBe(2);
  });

  it("does nothing when there is no session to close", async () => {
    const { session } = harness();
    expect((await session.close({ checkpoint: true, localText: "", operationId: "r" })).outcome).toBe("not-hot");
  });
});
