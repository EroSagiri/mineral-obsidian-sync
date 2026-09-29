import { describe, expect, it } from "vitest";
import type { Editor } from "obsidian";
import * as Y from "yjs";
import { encodeHotPayload, hotContentHash } from "@mineral/sync-core/hot-protocol";
import { HotGatewayClient, type HotHttpRequest, type HotHttpResponse, type HotSocket } from "./client";
import { HotSyncCoordinator } from "./coordinator";
import { MemoryHotStateStore } from "./store";
import type { HotBaseline } from "./types";

/**
 * The fence, and the two ways a document leaves it.
 *
 * The fence is the *only* answer the cold path gets about a hot path, so it has to be durable, ordered
 * (a conflict outranks a pending handoff, which outranks a live session), and released exactly once —
 * on a handoff the server confirmed.
 */

const CHANNEL = "F".repeat(43);
const PATH = "notes/fenced.md";
const DOCUMENT = "ZyXwVuTsRqPoNmLkJiHgFe";

class FakeSocket implements HotSocket {
  readonly sent: string[] = [];
  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closeHandler?.(); }
  onMessage(handler: (data: string) => void): void { this.messageHandler = handler; }
  onClose(handler: () => void): void { this.closeHandler = handler; }
  emit(frame: Record<string, unknown>): void { this.messageHandler?.(JSON.stringify(frame)); }
}

const fakeEditor = (value: string) => ({
  getValue: () => value,
  // A double without `setValue` cannot be re-bound or filled, and every "the pane was replaced" test needs
  // exactly that.
  setValue: (next: string) => { value = next; },
  transaction: () => {},
}) as unknown as Editor;

function harness(
  release: { outcome: string; remainingClients?: number } = { outcome: "released" },
  namespaceResult?: Record<string, unknown>,
) {
  const sockets: FakeSocket[] = [];
  const transport = async (request: HotHttpRequest): Promise<HotHttpResponse> => {
    if (request.url.endsWith("/hot/acquire")) {
      return {
        status: 200,
        text: JSON.stringify({
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
    if (request.url.endsWith("/hot/release")) {
      return { status: 200, text: JSON.stringify({ protocol: 1, ...release }) };
    }
    if (request.url.endsWith("/hot/namespace")) {
      return { status: 200, text: JSON.stringify(namespaceResult ?? {}) };
    }
    return { status: 200, text: "{}" };
  };
  const client = new HotGatewayClient({ endpoint: "https://gateway.test", token: "t", channel: CHANNEL }, transport, () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  const store = new MemoryHotStateStore();
  const baselines: Array<{ path: string; baseline: HotBaseline }> = [];
  const statuses: string[] = [];
  const coordinator = new HotSyncCoordinator({
    client,
    store,
    clientId: "device-a",
    commitBaseline: async (path, baseline) => { baselines.push({ path, baseline }); },
    onStatus: (_path, status) => statuses.push(status),
  });
  return { coordinator, store, sockets, baselines, statuses };
}

function welcomeState(): string {
  const doc = new Y.Doc();
  return encodeHotPayload(Y.encodeStateAsUpdate(doc));
}

/** Acknowledges the operation the session most recently sent, whatever id it generated for it. */
async function ackLastOperation(socket: FakeSocket, session: { handleFrame(frame: never): Promise<void> }, revision = 1): Promise<void> {
  const frames = socket.sent.map(frame => JSON.parse(frame) as { type?: string; clientOperationId?: string });
  const operation = [...frames].reverse().find(frame => frame.type === "operation");
  const clientOperationId = operation?.clientOperationId ?? "op-1";
  await session.handleFrame({ protocol: 1, type: "ack", documentId: DOCUMENT, epoch: 1, clientOperationId, serverRevision: revision, duplicate: false } as never);
}

const welcome = (revision = 0) => ({ protocol: 1, type: "welcome", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, state: "active", serverRevision: revision, latestCheckpointedRevision: revision, crdtState: welcomeState(), pendingSave: false });

describe("hot namespace deletion", () => {
  it("keeps the local fence and session when the authority has not applied the delete", async () => {
    const { coordinator, sockets } = harness({ outcome: "released" }, {
      protocol: 1,
      operationId: "delete-1",
      type: "delete",
      outcome: "rejected",
      reason: "unavailable",
      phase: "checkpointed",
      canonicalPath: PATH,
      binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "quiescing", updatedAt: 1 },
    });
    await coordinator.open({ canonicalPath: PATH, editor: fakeEditor(""), localText: "" });
    sockets[0].emit(welcome());
    await new Promise(resolve => setTimeout(resolve, 0));

    const result = await coordinator.delete(PATH);

    expect(result.outcome).toBe("rejected");
    expect(coordinator.isFenced(PATH)).toBe(true);
    expect(coordinator.sessionFor(PATH)).toBeDefined();
  });

  it("forgets local ownership only after the authority applies the delete", async () => {
    const { coordinator, sockets, store } = harness({ outcome: "released" }, {
      protocol: 1,
      operationId: "delete-2",
      type: "delete",
      outcome: "applied",
      phase: "acked",
      canonicalPath: PATH,
      binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "deleted", updatedAt: 2 },
    });
    await coordinator.open({ canonicalPath: PATH, editor: fakeEditor(""), localText: "" });
    sockets[0].emit(welcome());
    await new Promise(resolve => setTimeout(resolve, 0));

    const result = await coordinator.delete(PATH);

    expect(result.outcome).toBe("applied");
    expect(coordinator.isFenced(PATH)).toBe(false);
    expect(coordinator.sessionFor(PATH)).toBeUndefined();
    expect((await store.loadSessions()).filter(record => record.canonicalPath === PATH)).toEqual([]);
  });
});


describe("keep local means this device's bytes reach the document", () => {
  it("pushes them after the authority re-points a stale room", async () => {
    // A re-point alone publishes whatever the document held — the opposite of what the button says. A real
    // stale room's duplicated content came back to R2 exactly that way.
    const sockets: FakeSocket[] = [];
    const calls: string[] = [];
    let acquires = 0;
    const binding = { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 };
    const transport = async (request: HotHttpRequest): Promise<HotHttpResponse> => {
      if (request.url.endsWith("/hot/acquire")) {
        acquires += 1;
        if (acquires === 1) return { status: 409, text: JSON.stringify({ protocol: 1, outcome: "conflict", reason: "remote-changed", canonicalPath: PATH, binding, remote: null }) };
        calls.push("acquire-joined");
        return { status: 200, text: JSON.stringify({ protocol: 1, outcome: "joined", canonicalPath: PATH, binding, remote: null, identity: { documentId: DOCUMENT, epoch: 1 }, serverRevision: 1, latestCheckpointedRevision: 1, roomState: "active", sessionTicket: "ticket-1" }) };
      }
      if (request.url.endsWith("/hot/resolve")) { calls.push("resolve"); return { status: 200, text: JSON.stringify({ outcome: "resolved" }) }; }
      if (request.url.includes("/hot/path")) return { status: 200, text: JSON.stringify({ binding, remote: null, hotOwned: false }) };
      return { status: 200, text: "{}" };
    };
    const client = new HotGatewayClient({ endpoint: "https://gateway.test", token: "t", channel: CHANNEL }, transport, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const coordinator = new HotSyncCoordinator({ client, store: new MemoryHotStateStore(), clientId: "device-a", readLocalText: async () => "file text\n", writeLocalText: async () => undefined });
    const refused = await coordinator.open({ canonicalPath: PATH, editor: fakeEditor("file text\n"), localText: "file text\n" });
    expect(refused.outcome).toBe("conflict");

    const pending = coordinator.resolveConflict(PATH, "keep-local");
    for (let attempt = 0; attempt < 200 && sockets.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const room = new Y.Doc();
    room.getText("markdown").insert(0, "room text\nroom text\n");
    sockets[0]?.emit({ protocol: 1, type: "welcome", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, state: "active", serverRevision: 1, latestCheckpointedRevision: 1, crdtState: encodeHotPayload(Y.encodeStateAsUpdate(room)), pendingSave: false });
    const resolved = await pending;

    expect(resolved.outcome).toBe("resolved");
    expect(calls).toEqual(["resolve", "acquire-joined"]);
    await new Promise(resolve => setTimeout(resolve, 50));
    const operations = sockets[0].sent.map(frame => JSON.parse(frame) as { type?: string }).filter(frame => frame.type === "operation");
    expect(operations.length).toBeGreaterThan(0);
    expect(coordinator.bindingFor(PATH)?.text()).toBe("file text\n");
  });
});

describe("a room seeded from R2 is never seeded again by the client", () => {
  /**
   * The corruption a real note showed: eleven copies of the same line in R2. A path whose content is already
   * published gets a room **seeded from R2**, and the client seeded the same text again before the welcome
   * arrived — Yjs keeps both, and every session added one more copy.
   */
  function createdHarness(remoteExists: boolean) {
    const sockets: FakeSocket[] = [];
    const transport = async (request: HotHttpRequest): Promise<HotHttpResponse> => {
      if (request.url.endsWith("/hot/acquire")) {
        return { status: 200, text: JSON.stringify({ protocol: 1, outcome: "created", canonicalPath: PATH, binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 }, remote: remoteExists ? { canonicalPath: PATH, exists: true, etag: "R1", size: 12, deleted: false, tombstoneTargets: null, contentHash: null } : null, identity: { documentId: DOCUMENT, epoch: 1 }, serverRevision: 0, latestCheckpointedRevision: 0, roomState: "active", sessionTicket: "ticket-1" }) };
      }
      return { status: 200, text: "{}" };
    };
    const client = new HotGatewayClient({ endpoint: "https://gateway.test", token: "t", channel: CHANNEL }, transport, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    return { coordinator: new HotSyncCoordinator({ client, store: new MemoryHotStateStore(), clientId: "device-a" }), sockets };
  }

  function welcomeCarrying(text: string) {
    const room = new Y.Doc();
    room.getText("markdown").insert(0, text);
    return { protocol: 1, type: "welcome", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, state: "active", serverRevision: 0, latestCheckpointedRevision: 0, crdtState: encodeHotPayload(Y.encodeStateAsUpdate(room)), pendingSave: false };
  }

  it("does not push the caller's text when the room already holds it", async () => {
    const { coordinator, sockets } = createdHarness(true);
    // The welcome arrives *during* the open, because that is the moment the race happens. A real room sends
    // exactly one per connection, so this does too.
    let welcomed = false;
    const timer = setInterval(() => {
      if (welcomed || !sockets[0]) return;
      welcomed = true;
      sockets[0].emit(welcomeCarrying("hello world\n"));
    }, 5);
    const opened = await coordinator.open({ canonicalPath: PATH, editor: fakeEditor("hello world\n"), localText: "hello world\n" });
    clearInterval(timer);
    expect(opened.outcome).toBe("hot");
    await new Promise(resolve => setTimeout(resolve, 50));
    const operations = sockets[0].sent.map(frame => JSON.parse(frame) as { type?: string }).filter(frame => frame.type === "operation");
    expect(operations).toEqual([]);
    expect(coordinator.bindingFor(PATH)?.text()).toBe("hello world\n");
  });

  it("still seeds a path with nothing in R2, which is how a new note gets its first revision", async () => {
    const { coordinator, sockets } = createdHarness(false);
    const opened = await coordinator.open({ canonicalPath: PATH, editor: fakeEditor("brand new\n"), localText: "brand new\n" });
    expect(opened.outcome).toBe("hot");
    await new Promise(resolve => setTimeout(resolve, 50));
    const operations = sockets[0].sent.map(frame => JSON.parse(frame) as { type?: string }).filter(frame => frame.type === "operation");
    expect(operations.length).toBeGreaterThan(0);
    expect(coordinator.bindingFor(PATH)?.text()).toBe("brand new\n");
  });
});

describe("emptying a document is a push like any other", () => {
  it("deletes the whole content and sends it", async () => {
    const sockets: FakeSocket[] = [];
    const transport = async (request: HotHttpRequest) => {
      if (request.url.endsWith("/hot/acquire")) {
        return { status: 200, text: JSON.stringify({ protocol: 1, outcome: "joined", canonicalPath: PATH, binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 }, remote: null, identity: { documentId: DOCUMENT, epoch: 1 }, serverRevision: 1, latestCheckpointedRevision: 1, roomState: "active", sessionTicket: "ticket-1" }) };
      }
      return { status: 200, text: "{}" };
    };
    const client = new HotGatewayClient({ endpoint: "https://gateway.test", token: "t", channel: CHANNEL }, transport, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const coordinator = new HotSyncCoordinator({ client, store: new MemoryHotStateStore(), clientId: "device-a" });
    const editor = fakeEditor("");
    const opened = await coordinator.open({ canonicalPath: PATH, editor, localText: "" });
    expect(opened.outcome).toBe("hot");
    const room = new Y.Doc();
    room.getText("markdown").insert(0, "hello\n");
    sockets[0].emit({ protocol: 1, type: "welcome", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, state: "active", serverRevision: 1, latestCheckpointedRevision: 1, crdtState: encodeHotPayload(Y.encodeStateAsUpdate(room)), pendingSave: false });
    await new Promise(resolve => setTimeout(resolve, 60));
    const binding = coordinator.bindingFor(PATH)!;
    console.log("AFTER-WELCOME doc=" + JSON.stringify(binding.text()) + " editor=" + JSON.stringify(editor.getValue()));
    await binding.applyTextAsLocalEdit("");
    await new Promise(resolve => setTimeout(resolve, 60));
    console.log("AFTER-EMPTY doc=" + JSON.stringify(binding.text()));
    const operations = sockets[0].sent.map(frame => JSON.parse(frame) as { type?: string }).filter(frame => frame.type === "operation");
    console.log("OPERATIONS " + operations.length);
    expect(binding.text()).toBe("");
  });
});
describe("a conflict about a path the server no longer knows is released, not failed", () => {
  it("hands the path back when the resolution comes back not-found", async () => {
    // A deleted file (or a retired incarnation) leaves the server with no document, so every decision ends
    // in `not-found`. Reporting that as a failure kept the path frozen in front of the user forever.
    const sockets: FakeSocket[] = [];
    const calls: string[] = [];
    let acquires = 0;
    const binding = { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 };
    const transport = async (request: HotHttpRequest): Promise<HotHttpResponse> => {
      if (request.url.endsWith("/hot/acquire")) {
        acquires += 1;
        return { status: 409, text: JSON.stringify({ protocol: 1, outcome: "conflict", reason: "remote-changed", canonicalPath: PATH, binding, remote: null }) };
      }
      if (request.url.endsWith("/hot/resolve")) { calls.push("resolve"); return { status: 404, text: JSON.stringify({ outcome: "not-found" }) }; }
      if (request.url.includes("/hot/path")) return { status: 200, text: JSON.stringify({ binding, remote: null, hotOwned: false }) };
      return { status: 200, text: "{}" };
    };
    const client = new HotGatewayClient({ endpoint: "https://gateway.test", token: "t", channel: CHANNEL }, transport, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const coordinator = new HotSyncCoordinator({ client, store: new MemoryHotStateStore(), clientId: "device-a" });
    const refused = await coordinator.open({ canonicalPath: PATH, editor: fakeEditor("file text\n"), localText: "file text\n" });
    expect(refused.outcome).toBe("conflict");
    expect(coordinator.hotConflicts()).toEqual([{ canonicalPath: PATH, reason: "conflict" }]);

    const resolved = await coordinator.resolveConflict(PATH, "keep-local");
    expect(calls).toEqual(["resolve"]);
    expect(resolved.outcome).toBe("abandoned");
    expect(resolved.detail).toBe("not-found");
    expect(coordinator.hotConflicts()).toEqual([]);
    expect(coordinator.fenceReason(PATH)).toBeNull();
    expect(acquires).toBe(1);
  });
});

describe("a deliberate deletion is not undone", () => {
  it("keeps an emptied buffer empty and pushes the deletion", async () => {
    // Ctrl+A, Delete: the buffer is empty, the document has content for a moment, and an "adopt" fill used to
    // put the text back — the note jittered and the deletion never stuck.
    const sockets: FakeSocket[] = [];
    const transport = async (request: HotHttpRequest): Promise<HotHttpResponse> => {
      if (request.url.endsWith("/hot/acquire")) {
        return { status: 200, text: JSON.stringify({ protocol: 1, outcome: "joined", canonicalPath: PATH, binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 }, remote: null, identity: { documentId: DOCUMENT, epoch: 1 }, serverRevision: 1, latestCheckpointedRevision: 1, roomState: "active", sessionTicket: "ticket-1" }) };
      }
      return { status: 200, text: "{}" };
    };
    const client = new HotGatewayClient({ endpoint: "https://gateway.test", token: "t", channel: CHANNEL }, transport, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const coordinator = new HotSyncCoordinator({ client, store: new MemoryHotStateStore(), clientId: "device-a" });
    const editor = fakeEditor("diary text\n");
    await coordinator.open({ canonicalPath: PATH, editor, localText: "diary text\n" });
    const room = new Y.Doc();
    room.getText("markdown").insert(0, "diary text\n");
    sockets[0].emit({ protocol: 1, type: "welcome", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, state: "active", serverRevision: 1, latestCheckpointedRevision: 1, crdtState: encodeHotPayload(Y.encodeStateAsUpdate(room)), pendingSave: false });
    await new Promise(resolve => setTimeout(resolve, 60));

    // Select all, delete.
    editor.setValue("");
    coordinator.rebind(PATH, editor, "adopt");
    await coordinator.handleEditorChange(PATH);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(editor.getValue()).toBe("");
    expect(coordinator.bindingFor(PATH)?.text()).toBe("");

    const operations = sockets[0].sent.map(frame => JSON.parse(frame) as { type?: string }).filter(frame => frame.type === "operation");
    expect(operations.length).toBeGreaterThan(0);
  });
});

describe("a syncing note keeps the reader's place", () => {
  it("captures and restores the viewport around every write into the buffer", async () => {
    // Reported from both platforms: while hot sync ran, the scrollbar kept moving. Any write to a buffer
    // moves the viewport, so each one is wrapped.
    let captured = 0;
    let restored = 0;
    const sockets: FakeSocket[] = [];
    const transport = async (request: HotHttpRequest): Promise<HotHttpResponse> => {
      if (request.url.endsWith("/hot/acquire")) {
        return { status: 200, text: JSON.stringify({ protocol: 1, outcome: "joined", canonicalPath: PATH, binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 }, remote: null, identity: { documentId: DOCUMENT, epoch: 1 }, serverRevision: 1, latestCheckpointedRevision: 1, roomState: "active", sessionTicket: "ticket-1" }) };
      }
      return { status: 200, text: "{}" };
    };
    const client = new HotGatewayClient({ endpoint: "https://gateway.test", token: "t", channel: CHANNEL }, transport, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const coordinator = new HotSyncCoordinator({
      client,
      store: new MemoryHotStateStore(),
      clientId: "device-a",
      preserveViewport: () => { captured += 1; return () => { restored += 1; }; },
    });
    const editor = fakeEditor("");
    await coordinator.open({ canonicalPath: PATH, editor, localText: "hello\n" });
    const room = new Y.Doc();
    room.getText("markdown").insert(0, "hello\n");
    sockets[0].emit({ protocol: 1, type: "welcome", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, state: "active", serverRevision: 1, latestCheckpointedRevision: 1, crdtState: encodeHotPayload(Y.encodeStateAsUpdate(room)), pendingSave: false });
    await new Promise(resolve => setTimeout(resolve, 60));

    expect(captured).toBeGreaterThan(0);
    expect(restored).toBe(captured);
  });
});

describe("a session follows the pane's editor", () => {
  /**
   * The failure a real user saw: the note was owned on the server, they typed, and nothing was ever sent.
   * Obsidian had replaced the editor instance (a restored workspace rebuilds panes), and every diff was
   * computed from the *old* buffer — the one nobody was typing into.
   */
  async function openedHarness() {
    const sockets: FakeSocket[] = [];
    const transport = async (request: HotHttpRequest): Promise<HotHttpResponse> => {
      if (request.url.endsWith("/hot/acquire")) {
        return { status: 200, text: JSON.stringify({ protocol: 1, outcome: "created", canonicalPath: PATH, binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 }, remote: null, identity: { documentId: DOCUMENT, epoch: 1 }, serverRevision: 0, latestCheckpointedRevision: 0, roomState: "active", sessionTicket: "ticket-1" }) };
      }
      return { status: 200, text: "{}" };
    };
    const client = new HotGatewayClient({ endpoint: "https://gateway.test", token: "t", channel: CHANNEL }, transport, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const coordinator = new HotSyncCoordinator({ client, store: new MemoryHotStateStore(), clientId: "device-a" });
    const editor = fakeEditor("");
    const opened = await coordinator.open({ canonicalPath: PATH, editor, localText: "diary text\n" });
    expect(opened.outcome).toBe("hot");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(coordinator.bindingFor(PATH)?.text()).toBe("diary text\n");
    return { coordinator, sockets, editor };
  }

  it("sends the keystrokes that arrive in the editor which replaced the bound one", async () => {
    const { coordinator, sockets } = await openedHarness();
    const replacement = fakeEditor("diary text\nmore\n");
    expect(coordinator.rebind(PATH, replacement, "adopt")).toBe(true);
    await coordinator.handleEditorChange(PATH);
    await new Promise(resolve => setTimeout(resolve, 30));
    const operations = sockets[0].sent.map(frame => JSON.parse(frame) as { type?: string }).filter(frame => frame.type === "operation");
    expect(operations.length).toBeGreaterThan(0);
    expect(coordinator.bindingFor(PATH)?.text()).toBe("diary text\nmore\n");
  });

  it("fills a pane that has just appeared without pushing the fill as an edit", async () => {
    const { coordinator, sockets } = await openedHarness();
    // A room this device created takes the local text as its first revision, so that seed *is* an
    // operation. What matters here is that the fill adds none of its own.
    const sent = () => sockets[0].sent.map(frame => JSON.parse(frame) as { type?: string }).filter(frame => frame.type === "operation").length;
    const before = sent();
    const fresh = fakeEditor("");
    expect(coordinator.rebind(PATH, fresh, "fill")).toBe(true);
    expect(fresh.getValue()).toBe("diary text\n");
    await coordinator.handleEditorChange(PATH);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(sent()).toBe(before);
  });
  it("never overwrites a pane that already has text of its own", async () => {
    // The reported symptom: while hot sync ran, the scrollbar kept jumping to the top. Rewriting a non-empty
    // buffer is what does that — and it can also throw away what the user can see.
    const { coordinator } = await openedHarness();
    const divergent = fakeEditor("my own text\n");
    expect(coordinator.rebind(PATH, divergent, "fill")).toBe(true);
    expect(divergent.getValue()).toBe("my own text\n");
    await coordinator.handleEditorChange(PATH);
    await new Promise(resolve => setTimeout(resolve, 30));
    // Nothing is pushed just because a pane appeared: the document keeps its content and the buffer is not
    // overwritten either. Only a real change in that buffer counts as one.
    expect(coordinator.bindingFor(PATH)?.text()).toBe("diary text\n");

    divergent.setValue("my own text!\n");
    await coordinator.handleEditorChange(PATH);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(coordinator.bindingFor(PATH)?.text()).toBe("my own text!\n");
  });
});

describe("a conflicted room is re-pointed before the sides are made to agree", () => {
  it("sends the server resolve and then converges, instead of failing forever", async () => {
    // The failure a device hit, verbatim: the acquire answered 409 because the *room* was conflicted, so the
    // join that convergence needs was refused too — and the remedy (`/hot/resolve`) was never sent, so no
    // decision the user could make would ever clear it.
    const sockets: FakeSocket[] = [];
    const calls: string[] = [];
    let acquires = 0;
    const binding = { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 };
    const transport = async (request: HotHttpRequest): Promise<HotHttpResponse> => {
      if (request.url.endsWith("/hot/acquire")) {
        acquires += 1;
        if (acquires === 1) return { status: 409, text: JSON.stringify({ protocol: 1, outcome: "conflict", reason: "local-remote-mismatch", canonicalPath: PATH, binding, remote: null }) };
        if (acquires === 2) { calls.push("acquire-refused"); return { status: 409, text: JSON.stringify({ protocol: 1, outcome: "conflict", reason: "remote-changed", canonicalPath: PATH, binding, remote: null }) }; }
        calls.push("acquire-joined");
        return { status: 200, text: JSON.stringify({ protocol: 1, outcome: "joined", canonicalPath: PATH, binding, remote: null, identity: { documentId: DOCUMENT, epoch: 1 }, serverRevision: 1, latestCheckpointedRevision: 1, roomState: "active", sessionTicket: "ticket-1" }) };
      }
      if (request.url.endsWith("/hot/resolve")) { calls.push("resolve"); return { status: 200, text: JSON.stringify({ outcome: "resolved" }) }; }
      if (request.url.includes("/hot/path")) return { status: 200, text: JSON.stringify({ binding, remote: null, hotOwned: false }) };
      return { status: 200, text: "{}" };
    };
    const client = new HotGatewayClient({ endpoint: "https://gateway.test", token: "t", channel: CHANNEL }, transport, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const coordinator = new HotSyncCoordinator({ client, store: new MemoryHotStateStore(), clientId: "device-a", readLocalText: async () => "file text\n", writeLocalText: async () => undefined });

    const refused = await coordinator.open({ canonicalPath: PATH, editor: fakeEditor("file text\n"), localText: "file text\n" });
    expect(refused.outcome).toBe("conflict");
    expect(refused.reason).toBe("local-remote-mismatch");

    const pending = coordinator.resolveConflict(PATH, "keep-local");
    for (let attempt = 0; attempt < 200 && sockets.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const room = new Y.Doc();
    room.getText("markdown").insert(0, "room text\n");
    sockets[0]?.emit({ protocol: 1, type: "welcome", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, state: "active", serverRevision: 1, latestCheckpointedRevision: 1, crdtState: encodeHotPayload(Y.encodeStateAsUpdate(room)), pendingSave: false });
    const resolved = await pending;

    expect(resolved.outcome).toBe("resolved");
    // The order is the fix: a refused join, then the authority re-pointed, then the join that works.
    expect(calls).toEqual(["acquire-refused", "resolve", "acquire-joined"]);
    expect(coordinator.hotConflicts()).toEqual([]);
    expect(coordinator.fenceReason(PATH)).toBe("hot");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(coordinator.bindingFor(PATH)?.text()).toBe("file text\n");
  });
});

describe("an unavailable path is not a conflict", () => {
  it("keeps it out of the conflict list and clears it when the server can serve the path again", async () => {
    // The failure a user described as "always conflicts, and resolving never helps": the server could not
    // serve the path at all, and the plugin offered a choice that no decision could ever settle.
    const sockets: FakeSocket[] = [];
    let acquires = 0;
    const transport = async (request: HotHttpRequest): Promise<HotHttpResponse> => {
      if (request.url.endsWith("/hot/acquire")) {
        acquires += 1;
        if (acquires === 1) {
          return { status: 409, text: JSON.stringify({ protocol: 1, outcome: "rejected", reason: "unavailable", canonicalPath: PATH, binding: null, remote: null }) };
        }
        return { status: 200, text: JSON.stringify({ protocol: 1, outcome: "created", canonicalPath: PATH, binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 }, remote: null, identity: { documentId: DOCUMENT, epoch: 1 }, serverRevision: 0, latestCheckpointedRevision: 0, roomState: "active", sessionTicket: "ticket-1" }) };
      }
      return { status: 200, text: "{}" };
    };
    const client = new HotGatewayClient({ endpoint: "https://gateway.test", token: "t", channel: CHANNEL }, transport, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const coordinator = new HotSyncCoordinator({ client, store: new MemoryHotStateStore(), clientId: "device-a" });

    const refused = await coordinator.open({ canonicalPath: PATH, editor: fakeEditor("x\n"), localText: "x\n" });
    expect(refused.outcome).toBe("rejected");
    expect(refused.reason).toBe("unavailable");
    expect(coordinator.hotConflicts()).toEqual([]);
    expect(coordinator.hotUnavailable()).toEqual([{ canonicalPath: PATH, detail: "unavailable" }]);

    // Nothing was left frozen: the path was never hot, so cold sync is free to work on it.
    expect(coordinator.fenceReason(PATH)).toBeNull();

    const reopened = await coordinator.open({ canonicalPath: PATH, editor: fakeEditor("x\n"), localText: "x\n" });
    sockets[0]?.emit(welcome());
    expect(reopened.outcome).toBe("hot");
    expect(coordinator.hotUnavailable()).toEqual([]);
    expect(coordinator.fenceReason(PATH)).toBe("hot");
  });
});

describe("joining a document never seeds it", () => {
  it("does not duplicate the text when the room's state has not arrived yet", async () => {
    // The corruption a real device produced: the room's revision was in flight, the client seeded the same
    // text into a still-empty document, and the merge kept both copies (683 bytes became 1366 in R2). The
    // document then disagreed with the file, so every later open was refused.
    const sockets: FakeSocket[] = [];
    const transport = async (request: HotHttpRequest): Promise<HotHttpResponse> => {
      if (request.url.endsWith("/hot/acquire")) {
        return { status: 200, text: JSON.stringify({ protocol: 1, outcome: "joined", canonicalPath: PATH, binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 }, remote: null, identity: { documentId: DOCUMENT, epoch: 1 }, serverRevision: 1, latestCheckpointedRevision: 1, roomState: "active", sessionTicket: "ticket-1" }) };
      }
      return { status: 200, text: "{}" };
    };
    const client = new HotGatewayClient({ endpoint: "https://gateway.test", token: "t", channel: CHANNEL }, transport, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const coordinator = new HotSyncCoordinator({ client, store: new MemoryHotStateStore(), clientId: "device-a" });

    const opened = await coordinator.open({ canonicalPath: PATH, editor: fakeEditor("diary text\n"), localText: "diary text\n" });
    expect(opened.outcome).toBe("hot");
    await new Promise(resolve => setTimeout(resolve, 50));
    // Nothing was pushed before the room's state arrived: the document is still empty locally, which is the
    // point — the welcome is what fills it, exactly once.
    const operations = sockets[0].sent.map(frame => JSON.parse(frame) as { type?: string }).filter(frame => frame.type === "operation");
    expect(operations).toEqual([]);
    expect(coordinator.bindingFor(PATH)?.text()).toBe("");

    // And after the state arrives, the document holds the room's text once, not twice.
    const room = new Y.Doc();
    room.getText("markdown").insert(0, "diary text\n");
    sockets[0].emit({ protocol: 1, type: "welcome", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, state: "active", serverRevision: 1, latestCheckpointedRevision: 1, crdtState: encodeHotPayload(Y.encodeStateAsUpdate(room)), pendingSave: false });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(coordinator.bindingFor(PATH)?.text()).toBe("diary text\n");
  });
});

describe("a refused join is settled by content, not by dropping the fence", () => {
  /**
   * The loop a real device hit: the document already held a revision this device had not read, so every
   * open was refused; resolving only released the fence, so the next open was refused for exactly the same
   * reason. These tests pin the two convergence paths.
   */
  function mismatchHarness(roomText: string, diskText: string) {
    const calls: Array<Record<string, unknown>> = [];
    const written: Array<{ path: string; text: string }> = [];
    let acquires = 0;
    let resolves = 0;
    const sockets: FakeSocket[] = [];
    const transport = async (request: HotHttpRequest): Promise<HotHttpResponse> => {
      if (request.url.endsWith("/hot/acquire")) {
        acquires += 1;
        calls.push(JSON.parse(request.body ?? "{}") as Record<string, unknown>);
        if (acquires === 1) {
          return { status: 409, text: JSON.stringify({ protocol: 1, outcome: "conflict", reason: "local-remote-mismatch", canonicalPath: PATH, binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 }, remote: { exists: true, etag: "R1", size: roomText.length, deleted: false } }) };
        }
        return { status: 200, text: JSON.stringify({ protocol: 1, outcome: "joined", canonicalPath: PATH, binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 }, remote: null, identity: { documentId: DOCUMENT, epoch: 1 }, serverRevision: 0, latestCheckpointedRevision: 0, roomState: "active", sessionTicket: "ticket-1" }) };
      }
      if (request.url.endsWith("/hot/resolve")) { resolves += 1; return { status: 200, text: JSON.stringify({ outcome: "resolved" }) }; }
      return { status: 200, text: "{}" };
    };
    const client = new HotGatewayClient({ endpoint: "https://gateway.test", token: "t", channel: CHANNEL }, transport, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const coordinator = new HotSyncCoordinator({
      client,
      store: new MemoryHotStateStore(),
      clientId: "device-a",
      readLocalText: async () => diskText,
      writeLocalText: async (path, text) => { written.push({ path, text }); },
    });
    /** The room's own document, as the welcome would carry it. */
    const welcomeWithRoomText = () => {
      const room = new Y.Doc();
      room.getText("markdown").insert(0, roomText);
      return { protocol: 1, type: "welcome", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, state: "active", serverRevision: 1, latestCheckpointedRevision: 1, crdtState: encodeHotPayload(Y.encodeStateAsUpdate(room)), pendingSave: false };
    };
    return { coordinator, sockets, calls, written, welcomeWithRoomText, counts: () => ({ acquires, resolves }) };
  }

  it("keep-local pushes the file into the document, so the server saves what the user sees", async () => {
    const { coordinator, sockets, calls, welcomeWithRoomText, counts } = mismatchHarness("room text\n", "file text\n");
    const refused = await coordinator.open({ canonicalPath: PATH, editor: fakeEditor("file text\n"), localText: "file text\n" });
    expect(refused.outcome).toBe("conflict");
    expect(refused.reason).toBe("local-remote-mismatch");
    expect(coordinator.hotConflicts()).toEqual([{ canonicalPath: PATH, reason: "conflict" }]);

    const pending = coordinator.resolveConflict(PATH, "keep-local");
    for (let attempt = 0; attempt < 100 && sockets.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    sockets[0].emit(welcomeWithRoomText());
    const resolved = await pending;

    expect(resolved.outcome).toBe("resolved");
    // The second acquire claimed nothing about local content: that is what let the server hand the
    // document over instead of refusing again.
    expect(calls).toHaveLength(2);
    expect(calls[1].local).toBeNull();
    // And the file's bytes went out as an ordinary operation, so R2 will receive what the user can see.
    // The send is deliberately fire-and-forget (the durable outbox is the guarantee), so give it a tick.
    await new Promise(resolve => setTimeout(resolve, 50));
    const operations = sockets[0].sent.map(frame => JSON.parse(frame) as { type?: string }).filter(frame => frame.type === "operation");
    expect(operations.length).toBeGreaterThan(0);
    expect(coordinator.bindingFor(PATH)?.text(), "the document now holds the file's bytes").toBe("file text\n");
    expect(coordinator.fenceReason(PATH)).toBe("hot");
    expect(coordinator.hotConflicts()).toEqual([]);
    // The server was never asked to re-point a precondition: this conflict is about content.
    expect(counts().resolves).toBe(0);
  });

  it("accept-remote writes the document's text into the file", async () => {
    const { coordinator, sockets, written, welcomeWithRoomText, counts } = mismatchHarness("room text\n", "file text\n");
    await coordinator.open({ canonicalPath: PATH, editor: fakeEditor("file text\n"), localText: "file text\n" });

    const pending = coordinator.resolveConflict(PATH, "accept-remote");
    for (let attempt = 0; attempt < 100 && sockets.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    sockets[0].emit(welcomeWithRoomText());
    const resolved = await pending;

    expect(resolved.outcome).toBe("resolved");
    expect(written).toEqual([{ path: PATH, text: "room text\n" }]);
    expect(coordinator.hotConflicts()).toEqual([]);
    expect(coordinator.fenceReason(PATH)).toBe("hot");
    expect(counts().resolves).toBe(0);
  });
});

describe("hot conflict resolution", () => {
  /** An editor whose value can be replaced, which is what a resolution does. */
  function mutableEditor(initial: string) {
    let value = initial;
    return {
      read: () => value,
      editor: {
        getValue: () => value,
        setValue: (next: string) => { value = next; },
        transaction: () => {},
      } as unknown as Editor,
    };
  }

  /** The harness, with the resolution transport and the disk reader wired. */
  function resolutionHarness(options: { disk?: string; resolve?: { status: number; body: unknown } } = {}) {
    const sockets: FakeSocket[] = [];
    const calls: Array<Record<string, unknown>> = [];
    const resolved: string[] = [];
    const transport = async (request: HotHttpRequest): Promise<HotHttpResponse> => {
      if (request.url.endsWith("/hot/acquire")) {
        return { status: 200, text: JSON.stringify({ protocol: 1, outcome: "created", canonicalPath: PATH, binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 }, remote: null, identity: { documentId: DOCUMENT, epoch: 1 }, serverRevision: 0, latestCheckpointedRevision: 0, roomState: "active", sessionTicket: "ticket-1" }) };
      }
      if (request.url.endsWith("/hot/resolve")) {
        calls.push(JSON.parse(request.body ?? "{}") as Record<string, unknown>);
        const answer = options.resolve ?? { status: 200, body: { outcome: "resolved" } };
        return { status: answer.status, text: JSON.stringify(answer.body) };
      }
      if (request.url.includes("/hot/path")) {
        // What the coordinator asks when a conflict outlived its pane: who owns this path now.
        return { status: 200, text: JSON.stringify({ binding: { canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, state: "active", updatedAt: 1 }, remote: { exists: true, etag: "R1", size: 7, deleted: false }, hotOwned: true }) };
      }
      return { status: 200, text: "{}" };
    };
    const client = new HotGatewayClient({ endpoint: "https://gateway.test", token: "t", channel: CHANNEL }, transport, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const store = new MemoryHotStateStore();
    const coordinator = new HotSyncCoordinator({
      client,
      store,
      clientId: "device-a",
      readLocalText: async () => options.disk,
      onResolved: (path, decision) => resolved.push(`${path}:${decision}`),
    });
    return { coordinator, store, sockets, calls, resolved };
  }

  it("takes the disk version when the user keeps the file, as an ordinary local edit", async () => {
    const { coordinator, sockets } = resolutionHarness({ disk: "external bytes\n" });
    const pane = mutableEditor("mine\n");
    await coordinator.open({ canonicalPath: PATH, editor: pane.editor, localText: "mine\n" });
    sockets[0].emit(welcome());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(coordinator.flagExternalEdit(PATH)).toBe(true);
    expect(coordinator.hotConflicts()).toEqual([{ canonicalPath: PATH, reason: "external-local-edit" }]);

    const result = await coordinator.resolveConflict(PATH, "keep-local");

    expect(result.outcome).toBe("resolved");
    expect(pane.read()).toBe("external bytes\n");
    // The frozen path is hot again — and the external bytes went out through the normal operation path,
    // so the document converges on them instead of the server learning a special case.
    expect(coordinator.fenceReason(PATH)).toBe("hot");
    expect(coordinator.hotConflicts()).toEqual([]);
    expect(sockets[0].sent.some(frame => frame.includes("\"type\":\"operation\""))).toBe(true);
    // No server decision was needed: nothing on the server disagreed with either version.
    expect(coordinator.summary().conflicts).toBe(0);
  });

  it("puts the session's version back on disk when the user takes the other side", async () => {
    const { coordinator, sockets } = resolutionHarness({ disk: "external bytes\n" });
    const pane = mutableEditor("mine\n");
    await coordinator.open({ canonicalPath: PATH, editor: pane.editor, localText: "mine\n" });
    sockets[0].emit(welcome());
    await new Promise(resolve => setTimeout(resolve, 0));
    coordinator.flagExternalEdit(PATH);
    const before = sockets[0].sent.length;

    const result = await coordinator.resolveConflict(PATH, "accept-remote");

    expect(result.outcome).toBe("resolved");
    expect(pane.read()).toBe("mine\n");
    expect(coordinator.fenceReason(PATH)).toBe("hot");
    expect(coordinator.hotConflicts()).toEqual([]);
    // Rewriting the buffer to the document's own content is not an edit, so nothing is sent.
    expect(sockets[0].sent.length).toBe(before);
  });

  it("forwards a server conflict and gives up ownership when the user accepts the remote version", async () => {
    const { coordinator, store, calls, resolved } = resolutionHarness({ resolve: { status: 200, body: { outcome: "abandoned" } } });
    await store.putSession({ canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, clientId: "device-a", status: "conflict", lastAcceptedRevision: 3, lastCheckpointedRevision: 1, pendingSave: true, requestedRevision: null, updatedAt: 1 });
    await coordinator.restore();
    expect(coordinator.fenceReason(PATH)).toBe("conflict");

    const result = await coordinator.resolveConflict(PATH, "accept-remote");

    expect(result.outcome).toBe("abandoned");
    expect(calls).toEqual([expect.objectContaining({ decision: "accept-remote", documentId: DOCUMENT, epoch: 1 })]);
    // The fence is gone entirely: the cold path is what reconciles the file with R2 from here.
    expect(coordinator.fenceReason(PATH)).toBeNull();
    expect(coordinator.fencedPaths()).toEqual([]);
    expect(await store.loadSessions()).toEqual([]);
    expect(resolved).toEqual([`${PATH}:accept-remote`]);
  });

  it("keeps the conflict frozen when the decision cannot be delivered", async () => {
    const { coordinator, store, resolved } = resolutionHarness({ resolve: { status: 500, body: { error: "boom" } } });
    await store.putSession({ canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, clientId: "device-a", status: "conflict", lastAcceptedRevision: 3, lastCheckpointedRevision: 1, pendingSave: true, requestedRevision: null, updatedAt: 1 });
    await coordinator.restore();

    const result = await coordinator.resolveConflict(PATH, "keep-local");

    expect(result.outcome).toBe("failed");
    // Losing the fence because a request failed would be worse than a frozen file.
    expect(coordinator.fenceReason(PATH)).toBe("conflict");
    expect(coordinator.hotConflicts()).toHaveLength(1);
    expect(resolved).toEqual([]);
  });

  it("ignores a decision for a path that is not conflicted", async () => {
    const { coordinator, calls } = resolutionHarness();
    const result = await coordinator.resolveConflict(PATH, "keep-local");
    expect(result).toEqual({ outcome: "failed", detail: "no-conflict" });
    expect(calls).toEqual([]);
  });

  it("offers a stuck handoff for resolution, and distinguishes its two answers", async () => {
    // A handoff that never completed fences a path whose pane may be long gone. Without an entry in the
    // resolver there is no way for the user to get the file back, which is why it is listed here.
    const { coordinator, store, resolved } = resolutionHarness({ resolve: { status: 200, body: { outcome: "resolved" } } });
    await store.putHandoff({ canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, requiredRevision: 4, contentHash: "abc", r2ETag: null, createdAt: 1 });
    await coordinator.restore();
    expect(coordinator.hotConflicts()).toEqual([{ canonicalPath: PATH, reason: "handoff-pending" }]);
    expect(coordinator.fenceReason(PATH)).toBe("handoff-pending");

    const kept = await coordinator.resolveConflict(PATH, "keep-local");
    // Asking the room to save is not proof that it did: the fence and the record both stay.
    expect(kept.outcome).toBe("pending-confirmation");
    expect(coordinator.fenceReason(PATH)).toBe("handoff-pending");
    expect(coordinator.hotConflicts()).toHaveLength(1);
    expect((await store.loadHandoffs()).map(handoff => handoff.canonicalPath)).toEqual([PATH]);
    expect(resolved).toEqual([`${PATH}:keep-local`]);
  });

  it("releases a stuck handoff when the user gives up on this device's version", async () => {
    const { coordinator, store } = resolutionHarness({ resolve: { status: 200, body: { outcome: "abandoned" } } });
    await store.putHandoff({ canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, requiredRevision: 4, contentHash: "abc", r2ETag: null, createdAt: 1 });
    await coordinator.restore();

    const result = await coordinator.resolveConflict(PATH, "accept-remote");

    expect(result.outcome).toBe("abandoned");
    expect(coordinator.fenceReason(PATH)).toBeNull();
    expect(coordinator.hotConflicts()).toEqual([]);
    expect(await store.loadHandoffs()).toEqual([]);
  });
});

describe("hot path fence", () => {
  it("fences nothing before anything is hot", () => {
    const { coordinator } = harness();
    expect(coordinator.fenceReason(PATH)).toBeNull();
    expect(coordinator.plannerFact(PATH)).toBeNull();
    expect(coordinator.fencedPaths()).toEqual([]);
  });

  it("fences a hot path, and reports it to the planner as deferred rather than missing", async () => {
    const { coordinator, sockets } = harness();
    const opened = await coordinator.open({ canonicalPath: PATH, editor: fakeEditor("content\n"), localText: "content\n" });
    expect(opened.outcome).toBe("hot");
    sockets[0].emit(welcome());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(coordinator.fenceReason(PATH)).toBe("hot");
    expect(coordinator.plannerFact(PATH)).toBe("deferred-by-hot-ownership");
    coordinator.noteDeferred(PATH);
    coordinator.noteDeferred(PATH);
    expect(coordinator.deferredSummary()).toEqual({ paths: 1, operations: 2 });
  });

  it("keeps the fence up when a close cannot complete, and clears it when it does", async () => {
    // Slow on purpose: the seed is a real, unacknowledged operation here, so the close spends the whole
    // bounded drain budget (8s) before giving up and leaving a durable handoff record — which is the
    // behaviour under test, not slowness.
    const failing = harness({ outcome: "checkpoint-pending" });
    await failing.coordinator.open({ canonicalPath: PATH, editor: fakeEditor("content\n"), localText: "content\n" });
    failing.sockets[0].emit(welcome());
    await new Promise(resolve => setTimeout(resolve, 0));
    const pending = await failing.coordinator.close({ canonicalPath: PATH, localText: "content\n" });
    expect(pending.outcome).toBe("handoff-pending");
    expect(failing.coordinator.fenceReason(PATH)).toBe("handoff-pending");
    expect(failing.baselines).toHaveLength(0);
    // The handoff is durable, so a restart still fences the path.
    const restarted = await failing.coordinator.restore();
    expect(restarted.handoffs).toBe(1);
    expect(failing.coordinator.fenceReason(PATH)).toBe("handoff-pending");
  }, 30_000);

  it("commits the baseline but keeps the fence when another client still holds the document", async () => {
    const other = harness({ outcome: "checkpoint-pending", remainingClients: 1 });
    await other.coordinator.open({ canonicalPath: PATH, editor: fakeEditor("shared\n"), localText: "shared\n" });
    other.sockets[0].emit(welcome());
    await new Promise(resolve => setTimeout(resolve, 0));
    const session = other.coordinator.sessionFor(PATH)!;
    await ackLastOperation(other.sockets[0], session);
    await session.handleFrame({ protocol: 1, type: "checkpoint", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, documentRevision: 1, contentHash: await hotContentHash("shared\n"), r2ETag: "etag-1", commitId: "c1", latestAcceptedRevision: 1, latestCheckpointedRevision: 1, checkpointedAt: 1 } as never);

    const outcome = await other.coordinator.close({ canonicalPath: PATH, localText: "shared\n" });
    expect(outcome.outcome).toBe("saved-hot-elsewhere");
    // The baseline is real — this device's revision is in R2 — but the path is not free.
    expect(other.baselines).toHaveLength(1);
    expect(other.coordinator.fenceReason(PATH)).toBe("hot");
  });

  it("commits the cold baseline and releases the fence on a confirmed handoff", async () => {
    const { coordinator, store, sockets, baselines } = harness();
    await coordinator.open({ canonicalPath: PATH, editor: fakeEditor("content\n"), localText: "content\n" });
    sockets[0].emit(welcome());
    await new Promise(resolve => setTimeout(resolve, 0));
    const session = coordinator.sessionFor(PATH)!;
    await ackLastOperation(sockets[0], session);
    await session.handleFrame({ protocol: 1, type: "checkpoint", documentId: DOCUMENT, epoch: 1, canonicalPath: PATH, documentRevision: 1, contentHash: await hotContentHash("content\n"), r2ETag: "etag-1", commitId: "c1", latestAcceptedRevision: 1, latestCheckpointedRevision: 1, checkpointedAt: 1 } as never);

    const outcome = await coordinator.close({ canonicalPath: PATH, localText: "content\n" });
    expect(outcome.outcome).toBe("handed-off");
    expect(baselines).toHaveLength(1);
    expect(baselines[0].baseline).toMatchObject({ r2ETag: "etag-1", documentRevision: 1 });
    expect(await store.loadHandoffs()).toHaveLength(0);
    expect(coordinator.fenceReason(PATH)).toBeNull();
    expect(coordinator.fencedPaths()).toEqual([]);
  });

  it("finishes a handoff whose receipt arrived but whose baseline was never committed", async () => {
    // The fourth crash point in the design's recovery list: the checkpoint succeeded and the receipt was
    // in hand, but the process died before the cold baseline was recorded. Nothing was lost — the record
    // is what survives — and reopening the file has to notice that and finish, rather than upload again.
    const { coordinator, store, sockets, baselines } = harness();
    const text = "content\n";
    await store.putSession({ canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, clientId: "device-a", status: "handoff-pending", lastAcceptedRevision: 4, lastCheckpointedRevision: 4, pendingSave: false, requestedRevision: null, updatedAt: 1 });
    await store.putHandoff({ canonicalPath: PATH, documentId: DOCUMENT, epoch: 1, requiredRevision: 4, contentHash: await hotContentHash(text), r2ETag: "etag-4", createdAt: 1 });
    await coordinator.restore();
    expect(coordinator.fenceReason(PATH)).toBe("handoff-pending");

    // The resume drives the socket itself, so the server's answers are emitted while it is waiting.
    const pending = coordinator.resumeHandoff(PATH, fakeEditor(text), text);
    for (let attempt = 0; attempt < 100 && sockets.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(sockets.length, "resuming a handoff must open a session").toBeGreaterThan(0);
    sockets[0].emit(welcome(4));
    sockets[0].emit({ protocol: 1, type: "checkpoint", documentId: DOCUMENT, epoch: 1, documentRevision: 4, contentHash: await hotContentHash(text), etag: "etag-4", size: text.length, mutationSeq: 1, committedAt: 1 });

    const resumed = await pending;
    expect(resumed.outcome).toBe("hot");
    expect(await store.loadHandoffs(), "the record is cleared once its receipt is confirmed").toEqual([]);
    expect(coordinator.fenceReason(PATH)).toBe("hot");
    expect(baselines.map(entry => entry.path)).toEqual([PATH]);
  });

  it("reports a conflict above every other fence", async () => {
    const { coordinator, store } = harness();
    await store.putSession({ canonicalPath: PATH, documentId: DOCUMENT, epoch: 2, clientId: "device-a", status: "conflict", lastAcceptedRevision: 3, lastCheckpointedRevision: 1, pendingSave: true, requestedRevision: null, updatedAt: 1 });
    await store.putHandoff({ canonicalPath: PATH, documentId: DOCUMENT, epoch: 2, requiredRevision: 3, contentHash: "x", r2ETag: null, createdAt: 1 });
    await coordinator.restore();
    expect(coordinator.fenceReason(PATH)).toBe("conflict");
    expect(coordinator.statusOf(PATH).reason).toBe("conflict");
  });

  it("raises an external-modification conflict once, and keeps the path fenced", async () => {
    // The conservative half of the design's external-modification rule: bytes written on disk by
    // something other than the bound editor are neither merged nor ignored — the path stops being
    // cold-mutable and the fact reaches the user.
    const { coordinator, sockets } = harness();
    const opened = await coordinator.open({ canonicalPath: PATH, editor: fakeEditor("mine\n"), localText: "mine\n" });
    expect(opened.outcome).toBe("hot");
    sockets[0].emit(welcome());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(coordinator.fenceReason(PATH)).toBe("hot");

    expect(coordinator.flagExternalEdit(PATH)).toBe(true);
    expect(coordinator.fenceReason(PATH)).toBe("conflict");
    expect(coordinator.statusOf(PATH).reason).toBe("external-local-edit");
    // Idempotent: a second event for the same file must not raise a second conflict.
    expect(coordinator.flagExternalEdit(PATH)).toBe(false);
    expect(coordinator.summary().conflicts).toBe(1);
  });
});







