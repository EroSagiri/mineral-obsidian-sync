import { describe, expect, it } from "vitest";
import type { Editor } from "obsidian";
import { deriveRemoteChangeChannel } from "@mineral/sync-core/channel";
import { HotGatewayClient, type HotHttpRequest, type HotSocket } from "./client";
import { HotEditorBinding } from "./editor-binding";
import { HotSyncCoordinator } from "./coordinator";
import { MemoryHotStateStore } from "./store";

/**
 * The plugin's hot path, driven against a **deployed** Gateway and Vault.
 *
 * It is skipped unless the environment provides a gateway URL, a token file, and an R2 identity file,
 * because it writes to a real namespace — under `.mineral/hot-verify/`, which the plugin ignores
 * and the index excludes. Everything else in this repository's hot tests runs in-process against
 * fakes; this one is the only place where "does the plugin's own code talk to the real service?" is
 * answered by the real service.
 *
 *   HOT_E2E_GATEWAY=https://sync.example.com \
 *   HOT_E2E_TOKEN_FILE=%TEMP%/token.txt \
 *   HOT_E2E_IDENTITY_FILE=%TEMP%/identity.json \
 *   npx vitest run src/hot/deployed.integration.test.ts
 */

const gateway = process.env.HOT_E2E_GATEWAY;
const tokenFile = process.env.HOT_E2E_TOKEN_FILE;
const identityFile = process.env.HOT_E2E_IDENTITY_FILE;
const enabled = Boolean(gateway && tokenFile && identityFile);

/** Node's fetch plus a timeout; the plugin uses Obsidian's `requestUrl` for the same shape. */
function nodeTransport(token: string) {
  return async (request: HotHttpRequest): Promise<{ status: number; text: string }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers, Authorization: `Bearer ${token}` },
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: controller.signal,
      });
      return { status: response.status, text: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Node's global WebSocket, adapted to the interface the plugin's client expects. */
function nodeSocketFactory(url: string): HotSocket {
  const socket = new WebSocket(url);
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onMessage: (handler) => socket.addEventListener("message", event => handler(String(event.data))),
    onClose: (handler) => socket.addEventListener("close", () => handler()),
  };
}

/**
 * Node's fetch in the shape the R2 client's transport expects.
 *
 * The plugin's own transport is Obsidian's `requestUrl`, which only exists inside Obsidian — but the
 * point of the external-writer case below is a write that goes *around* the room, so it has to be a real
 * signed R2 request.
 */
function nodeR2Transport() {
  return {
    async send(request: { method: string; url: string; headers: Record<string, string>; body?: unknown }) {
      const body = request.body as { kind?: string; text?: string; bytes?: ArrayBuffer } | undefined;
      const payload = body === undefined ? undefined : body.kind === "text" ? body.text : body.bytes;
      const response = await fetch(request.url, { method: request.method, headers: request.headers, body: payload as never });
      const buffer = await response.arrayBuffer();
      return {
        status: response.status,
        headers: Object.fromEntries((response.headers as unknown as { entries(): Iterable<[string, string]> }).entries()),
        text: new TextDecoder().decode(buffer),
        arrayBuffer: buffer,
      };
    },
  };
}

/** A minimal editor: the binding only ever reads `getValue()` and writes through `transaction()`. */
class TestEditor {
  constructor(public value = "") {}
  getValue(): string { return this.value; }
  /** The resolution path rewrites the buffer through this, exactly as Obsidian's own Editor does. */
  setValue(next: string): void { this.value = next; }
  transaction(tx: { changes?: Array<{ from: { line: number; ch: number }; to: { line: number; ch: number }; text?: string }> }): void {
    const changes = [...(tx.changes ?? [])]
      .map(change => ({ from: this.offset(change.from), to: this.offset(change.to), text: change.text ?? "" }))
      .sort((left, right) => right.from - left.from);
    for (const change of changes) this.value = this.value.slice(0, change.from) + change.text + this.value.slice(change.to);
  }
  private offset(position: { line: number; ch: number }): number {
    let offset = 0;
    let line = 0;
    while (line < position.line) {
      const next = this.value.indexOf("\n", offset);
      if (next < 0) return this.value.length;
      offset = next + 1;
      line += 1;
    }
    return Math.min(offset + position.ch, this.value.length);
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, attempts = 40): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return check();
}

describe.skipIf(!enabled)("hot sync against the deployed gateway", () => {
  it("propagates edits between two devices and hands the path back on close", async () => {
    const { readFileSync } = await import("node:fs");
    const token = readFileSync(tokenFile!, "utf8").trim();
    const identity = JSON.parse(readFileSync(identityFile!, "utf8")) as { endpoint: string; bucket: string; remotePrefix?: string };
    const channel = await deriveRemoteChangeChannel({ endpoint: identity.endpoint, bucket: identity.bucket, remotePrefix: identity.remotePrefix ?? "" });
    const path = `.mineral/hot-verify/plugin-${Date.now().toString(36)}/note.md`;

    const devices = ["plugin-a", "plugin-b"].map(clientId => {
      const client = new HotGatewayClient({ endpoint: gateway!, token, channel }, nodeTransport(token), nodeSocketFactory);
      const editor = new TestEditor("");
      const store = new MemoryHotStateStore();
      let coordinator: HotSyncCoordinator;
      const binding = new HotEditorBinding({
        editor: editor as unknown as Editor,
        onLocalUpdate: (update, operationId) => { void coordinator.sessionFor(path)?.applyLocalUpdate(update, operationId); },
      });
      coordinator = new HotSyncCoordinator({ client, store, clientId });
      return { clientId, client, editor, store, coordinator, binding };
    });

    const [a, b] = devices;
    const openedA = await a.coordinator.open({ canonicalPath: path, editor: a.editor as unknown as Editor, localText: "" });
    expect(openedA.outcome).toBe("hot");
    await waitFor(() => a.coordinator.statusOf(path).status === "hot");

    const openedB = await b.coordinator.open({ canonicalPath: path, editor: b.editor as unknown as Editor, localText: "" });
    expect(openedB.outcome).toBe("hot");
    await waitFor(() => b.coordinator.statusOf(path).status === "hot");
    expect(openedB.identity?.documentId).toBe(openedA.identity?.documentId);

    // Device A types; device B's editor receives it.
    a.editor.value = "hello from A\n";
    await a.coordinator.handleEditorChange(path);
    expect(await waitFor(() => b.editor.value === "hello from A\n")).toBe(true);

    // Device B replies; device A converges.
    b.editor.value = "hello from A\nand B\n";
    await b.coordinator.handleEditorChange(path);
    expect(await waitFor(() => a.editor.value === "hello from A\nand B\n")).toBe(true);

    // A third device that never opened the document must be refused a cold mutation while the session
    // is live, and granted one once the last session has handed the path back. This is the cross-device
    // half of the fence, and only the deployed Gateway can answer it.
    const cold = new HotSyncCoordinator({
      client: new HotGatewayClient({ endpoint: gateway!, token, channel }, nodeTransport(token), nodeSocketFactory),
      store: new MemoryHotStateStore(),
      clientId: "plugin-cold",
    });
    expect(await cold.authorizeColdMutation(path)).toBe("deferred");

    // B leaves: the handoff must be verified against a receipt, which is where the whole design either
    // holds or does not.
    const closedB = await b.coordinator.close({ canonicalPath: path, localText: b.editor.value });
    // Device A is still editing, so this device's work is saved but the path is not free.
    expect(closedB.outcome).toBe("saved-hot-elsewhere");
    expect(closedB.receipt?.contentHash).toBe(await (await import("@mineral/sync-core/hot-protocol")).hotContentHash(b.editor.value));
    // A is still holding it, so the cold writer is still refused.
    expect(await cold.authorizeColdMutation(path)).toBe("deferred");

    // A keeps editing after B left, and its final handoff is the one that ends the session.
    a.editor.value = "hello from A\nand B\nafter B left\n";
    await a.coordinator.handleEditorChange(path);
    const closedA = await a.coordinator.close({ canonicalPath: path, localText: a.editor.value });
    expect(closedA.outcome).toBe("handed-off");

    // The path is cold again: the authority is granted, and the file in R2 is what the last device left.
    expect(await waitFor(async () => (await cold.authorizeColdMutation(path)) === "granted")).toBe(true);
    await cold.settleColdMutation(path);
    const status = await a.client.pathStatus(path);
    expect(status.hotOwned).toBe(false);
    expect(status.remote?.etag).toBe(closedA.receipt?.r2ETag ?? null);

    // Leave the namespace as it was found.
    const cleanup = await a.client.namespace({
      type: "delete",
      operationId: `cleanup-${Date.now().toString(36)}`,
      clientId: a.clientId,
      canonicalPath: path,
      documentId: closedA.receipt ? openedA.identity!.documentId : openedA.identity!.documentId,
      expectedEpoch: openedA.identity!.epoch,
      expectedRemoteETag: closedA.receipt?.r2ETag ?? null,
      expectedDocumentRevision: closedA.receipt?.documentRevision ?? null,
    });
    expect(["applied", "conflict"]).toContain(cleanup.outcome);
  }, 120_000);

  it("detects an external write and lets the user decide, against the deployed service", async () => {
    // The conflict path, end to end: a writer that knows nothing about the room replaces the object in
    // R2, the room's next checkpoint must refuse to overwrite it, and the user's decision must be able to
    // settle it. Every part of that is a claim about the *deployed* conditional write, so it is checked
    // against the deployed service rather than a fake.
    const { readFileSync } = await import("node:fs");
    const { hotContentHash } = await import("@mineral/sync-core/hot-protocol");
    const token = readFileSync(tokenFile!, "utf8").trim();
    const identity = JSON.parse(readFileSync(identityFile!, "utf8")) as { endpoint: string; bucket: string; remotePrefix?: string; accessKeyId: string; secretAccessKey: string };
    const channel = await deriveRemoteChangeChannel({ endpoint: identity.endpoint, bucket: identity.bucket, remotePrefix: identity.remotePrefix ?? "" });
    const path = `.mineral/hot-verify/conflict-${Date.now().toString(36)}/note.md`;

    const client = new HotGatewayClient({ endpoint: gateway!, token, channel }, nodeTransport(token), nodeSocketFactory);
    const store = new MemoryHotStateStore();
    // The editor starts empty, so the first content is a real edit the session has to send: opening with
    // text the document already holds would produce an empty diff and no revision to collide with.
    const editor = new TestEditor("");
    let coordinator: HotSyncCoordinator;
    const binding = new HotEditorBinding({
      editor: editor as unknown as Editor,
      onLocalUpdate: (update, operationId) => { void coordinator.sessionFor(path)?.applyLocalUpdate(update, operationId); },
    });
    coordinator = new HotSyncCoordinator({
      client,
      store,
      clientId: "plugin-conflict",
      // The client-side conflict the design also has to catch: bytes written underneath the editor.
      readLocalText: async () => "theirs\n",
    });
    binding.attach();

    const opened = await coordinator.open({ canonicalPath: path, editor: editor as unknown as Editor, localText: "" });
    expect(opened.outcome).toBe("hot");
    await waitFor(() => coordinator.statusOf(path).status === "hot");

    // The room must have a revision in R2 before an external writer can collide with it. The first
    // content arrives as an ordinary local edit, so this waits for its acknowledgement rather than
    // assuming the open itself produced one.
    const session = () => coordinator.sessionFor(path)!;
    editor.value = "ours\n";
    await coordinator.handleEditorChange(path);
    expect(await waitFor(() => (session().session?.lastAcceptedRevision ?? 0) >= 1)).toBe(true);
    const receipt = await session().requestCheckpoint(session().session!.lastAcceptedRevision);
    expect(receipt?.contentHash, "a revision has to be in R2 for a collision to be possible").toBe(await hotContentHash("ours\n"));

    // An external writer — the R2 API directly, with no room and no journal — replaces the object.
    const { SignedR2ListClient } = await import("../remote/r2-client");
    const external = new SignedR2ListClient({ endpoint: identity.endpoint, bucket: identity.bucket, accessKeyId: identity.accessKeyId, secretAccessKey: identity.secretAccessKey, remotePrefix: identity.remotePrefix ?? "" }, undefined, undefined, nodeR2Transport() as never);
    const beforeExternal = (await client.pathStatus(path)).remote;
    await external.putObject(path, new TextEncoder().encode("theirs\n").buffer, {});
    const afterExternal = (await client.pathStatus(path)).remote;
    // The collision has to be real before the rest of this test means anything.
    expect(afterExternal?.etag).not.toBe(beforeExternal?.etag);

    // The next checkpoint cannot be allowed to overwrite it.
    editor.value = "ours\nmore\n";
    await coordinator.handleEditorChange(path);
    // Wait for *this* edit to be acknowledged. Asking too early would be answered from the previous
    // receipt, which would make the assertion below pass for the wrong reason.
    expect(await waitFor(() => (session().session?.lastAcceptedRevision ?? 0) >= 2)).toBe(true);
    const conflicted = await session().requestCheckpoint(session().session!.lastAcceptedRevision);
    expect(conflicted, "the room must refuse to write over a revision it did not produce").toBeUndefined();
    expect(await waitFor(() => coordinator.statusOf(path).status === "conflict")).toBe(true);
    expect(coordinator.fenceReason(path)).toBe("conflict");

    // The user keeps this device's version: the room re-points at what R2 holds now and saves over it.
    const resolved = await coordinator.resolveConflict(path, "keep-local");
    expect(["resolved", "pending-confirmation"]).toContain(resolved.outcome);
    const saved = await waitFor(async () => {
      const bytes = await external.getObject(path);
      return (await hotContentHash(new TextDecoder().decode(bytes))) === (await hotContentHash(editor.value));
    }, 60);
    expect(saved, "the decided version is what R2 ends up holding").toBe(true);

    // And the local half of the design's rule: bytes written underneath the editor are *surfaced*.
    expect(coordinator.flagExternalEdit(path)).toBe(true);
    expect(coordinator.hotConflicts()).toEqual([{ canonicalPath: path, reason: "external-local-edit" }]);
    const keptDisk = await coordinator.resolveConflict(path, "keep-local");
    expect(keptDisk.outcome).toBe("resolved");
    expect(editor.value).toBe("theirs\n");

    await coordinator.close({ canonicalPath: path, localText: editor.value });
    const cleanup = await client.namespace({
      type: "delete",
      operationId: `cleanup-conflict-${Date.now().toString(36)}`,
      clientId: "plugin-conflict",
      canonicalPath: path,
      documentId: opened.identity!.documentId,
      expectedEpoch: opened.identity!.epoch,
      expectedRemoteETag: null,
      expectedDocumentRevision: null,
    });
    expect(["applied", "conflict"]).toContain(cleanup.outcome);
  }, 180_000);
});







