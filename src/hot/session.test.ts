import { describe, expect, it } from "vitest";
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

function harness(options: { release?: (body: Record<string, unknown>) => { status: number; text: string }; acquireBody?: Record<string, unknown> } = {}) {
  const requests: HotHttpRequest[] = [];
  const sockets: FakeSocket[] = [];
  const transport = async (request: HotHttpRequest): Promise<HotHttpResponse> => {
    requests.push(request);
    if (request.url.endsWith("/hot/release")) {
      return options.release?.(JSON.parse(request.body ?? "{}") as Record<string, unknown>) ?? { status: 200, text: JSON.stringify({ protocol: 1, outcome: "released", remainingClients: 0 }) };
    }
    if (request.url.endsWith("/hot/acquire")) {
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
  const doc = new FakeDocument();
  const statuses: HotSessionStatus[] = [];
  const conflicts: string[] = [];
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
    expect(session.pending()).toHaveLength(0);
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

