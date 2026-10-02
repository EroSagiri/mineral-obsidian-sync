import { hotContentHash, type CheckpointReceipt, type DocumentEpoch, type HotAcquireResult, type HotServerMessage } from "@mineral/sync-core/hot-protocol";
import { HotClientError, type HotGatewayClient, type HotSocket } from "./client";
import type { HotStateStore } from "./store";
import { outboxKey, type HotBaseline, type HotHandoffRecord, type HotOutboxEntry, type HotSessionRecord, type HotSessionStatus } from "./types";

/**
 * One live hot document session (Phase Hot-D).
 *
 * The rules this class exists to enforce:
 *
 * 1. **Durability before transport.** An edit is written to the persistent outbox *before* it is sent,
 *    so a crash between the keystroke and the acknowledgement costs nothing the server had already
 *    promised to keep.
 * 2. **The server owns the document.** Remote updates are applied verbatim; local edits are merged by
 *    the CRDT, never by overwriting.
 * 3. **Handoff is verified, not assumed.** A session ends only when a checkpoint receipt covers the
 *    last revision this device had acknowledged *and* the local file is exactly that revision's bytes.
 *    Anything else leaves a durable `handoff-pending` record that fences the cold path.
 * 4. **No timers decide correctness.** Backoff, retries, and reconnects are driven from outside; this
 *    class only ever acts on a durable fact.
 */

export interface HotDocumentPort {
  /** Applies a full CRDT state (a `welcome`), used when joining an existing room. */
  applyState(state: string): void;
  /** Applies one remote update. */
  applyRemote(update: string): void;
  /** The document's current text, for the handoff comparison. */
  text(): string;
}

export interface HotSessionEvents {
  onStatus?(status: HotSessionStatus, detail?: string): void;
  onCheckpoint?(receipt: CheckpointReceipt): void;
  onConflict?(reason: string): void;
  onDeleted?(): void;
  /** The same document moved to a new namespace path/epoch. */
  onRenamed?(fromPath: string, toPath: string, epoch: DocumentEpoch): void | Promise<void>;
  debug?(message: string): void;
}

export interface HotSessionDependencies {
  client: HotGatewayClient;
  store: HotStateStore;
  doc: HotDocumentPort;
  clientId: string;
  canonicalPath: string;
  events?: HotSessionEvents;
  now?: () => number;
  /** How long a caller waits for a checkpoint receipt before treating the save as unfinished. */
  receiptTimeoutMs?: number;
  /** How long a close waits for its own unacknowledged operations to be acknowledged. */
  drainTimeoutMs?: number;
  /** How long a close waits between drain attempts. */
  drainStepMs?: number;
  /** How many times a close re-asks for the release while another client is still counted. */
  releaseAttempts?: number;
  /** How long a close waits between release attempts. */
  releaseRetryDelayMs?: number;
  /** Initial delay before the first reconnect attempt after the socket closes unexpectedly. */
  reconnectInitialDelayMs?: number;
  /** Cap on the reconnect backoff so a long-lived session does not wait hours between attempts. */
  reconnectMaxDelayMs?: number;
  /** Generate the operation id used by `resume()` on each reconnect attempt; tests inject a counter. */
  nextReconnectOperationId?: () => string;
}

export type HotCloseOutcome = {
  /**
   * `handed-off` — this device's work is saved and the path is free.
   * `saved-hot-elsewhere` — this device's work is saved, but another client still holds the document,
   * so the path stays fenced here: the cold path must not race a session it cannot see.
   * `handoff-pending` — nothing confirms the save; the fence stays and no baseline may be written.
   */
  outcome: "handed-off" | "saved-hot-elsewhere" | "handoff-pending" | "failed" | "not-hot";
  receipt?: CheckpointReceipt;
  detail?: string;
};

type ReceiptWaiter = {
  minRevision: number;
  resolve: (value: { receipt: CheckpointReceipt } | { failure: string }) => void;
};

const DEFAULT_RECEIPT_TIMEOUT_MS = 15_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 8_000;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 250;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 15_000;

export class HotDocumentSession {
  observedServerRevision = 0;
  private record: HotSessionRecord | null = null;
  private socket: HotSocket | null = null;
  private outbox = new Map<string, HotOutboxEntry>();
  private waiters: ReceiptWaiter[] = [];
  /** The most recent receipt this session saw, so a close can confirm a save it did not request. */
  private lastReceipt: CheckpointReceipt | null = null;
  /** A timer for the next reconnect attempt; null when not waiting. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** The current backoff for the reconnect loop. Reset to the initial delay on a successful resume. */
  private reconnectDelay: number;
  private reconnectAttempts = 0;
  /** Local updates wait here while a namespace mutation settles and chooses their path/epoch. */
  private namespaceBarrier: Promise<void> | null = null;
  private namespaceBarrierRelease: (() => void) | null = null;
  /** Invalidates a reconnect that is already waiting on acquire when close/abandon begins. */
  private lifecycleGeneration = 0;
  private readonly events: HotSessionEvents;
  private readonly now: () => number;
  private readonly receiptTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly drainStepMs: number;
  private readonly releaseAttempts: number;
  private readonly releaseRetryDelayMs: number;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly nextReconnectOperationId: () => string;

  constructor(private readonly deps: HotSessionDependencies) {
    this.events = deps.events ?? {};
    this.now = deps.now ?? Date.now;
    this.receiptTimeoutMs = deps.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
    this.drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.drainStepMs = deps.drainStepMs ?? 100;
    this.releaseAttempts = deps.releaseAttempts ?? 4;
    this.releaseRetryDelayMs = deps.releaseRetryDelayMs ?? 250;
    this.reconnectInitialDelayMs = deps.reconnectInitialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
    this.reconnectMaxDelayMs = deps.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    this.reconnectDelay = this.reconnectInitialDelayMs;
    let reconnectCounter = 0;
    this.nextReconnectOperationId = deps.nextReconnectOperationId ?? (() => {
      reconnectCounter += 1;
      return `reconnect-${this.now().toString(36)}-${reconnectCounter.toString(36)}`;
    });
  }

  get path(): string {
    return this.record?.canonicalPath ?? this.deps.canonicalPath;
  }

  get session(): HotSessionRecord | null {
    return this.record;
  }

  get status(): HotSessionStatus {
    return this.record?.status ?? "idle";
  }

  get checkpointReceipt(): CheckpointReceipt | null {
    return this.lastReceipt;
  }

  epoch(): DocumentEpoch | null {
    return this.record?.epoch ?? null;
  }

  /** The operations this device has produced but not had acknowledged. */
  pending(): HotOutboxEntry[] {
    return [...this.outbox.values()].sort((left, right) => left.createdAt - right.createdAt);
  }

  private debug(message: string): void {
    this.events.debug?.(message);
  }

  private async persist(status: HotSessionStatus, detail?: string): Promise<void> {
    if (!this.record) return;
    this.record = { ...this.record, status, updatedAt: this.now() };
    await this.deps.store.putSession(this.record);
    this.events.onStatus?.(status, detail);
  }

  /** Replaces the record and persists it in one step, so no caller can forget the durable half. */
  private async setRecord(next: HotSessionRecord, notify = true): Promise<void> {
    const previousPath = this.record?.canonicalPath;
    this.record = next;
    await this.deps.store.putSession(next);
    // Session records are keyed by path. A namespace rename is a move, not a copy: retaining the old
    // key restores two authorities after reload and fences both names forever.
    if (previousPath && previousPath !== next.canonicalPath) {
      await this.deps.store.deleteSession(previousPath);
    }
    if (notify) this.events.onStatus?.(next.status);
  }

  /**
   * Stops newly produced editor updates at the durability boundary while rename/delete chooses an epoch.
   * The Y.Doc may continue to absorb typing; `applyLocalUpdate` resumes afterwards and persists that
   * update against the winning identity, so no keystroke is sent under a half-renamed namespace.
   */
  beginNamespaceTransition(): () => void {
    if (this.namespaceBarrier) throw new Error("a hot namespace transition is already active");
    this.namespaceBarrier = new Promise<void>(resolve => { this.namespaceBarrierRelease = resolve; });
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const release = this.namespaceBarrierRelease;
      this.namespaceBarrier = null;
      this.namespaceBarrierRelease = null;
      release?.();
    };
  }

  /** Applies the authoritative path+epoch returned by a successful namespace rename. */
  async adoptRename(canonicalPath: string, epoch: DocumentEpoch): Promise<void> {
    const record = this.record;
    if (!record) throw new Error("cannot rename a hot session without a record");
    if (epoch < record.epoch) return;
    const previousPath = record.canonicalPath;
    await this.setRecord({ ...record, canonicalPath, epoch, status: "hot", updatedAt: this.now() }, false);
    if (previousPath !== canonicalPath) await this.events.onRenamed?.(previousPath, canonicalPath, epoch);
  }

  async rememberRename(intent: HotSessionRecord["pendingRename"], nextPath?: string): Promise<void> {
    if (!this.record) throw new Error("cannot persist rename without a session");
    const next = { ...this.record };
    if (intent) next.pendingRename = intent;
    else delete next.pendingRename;
    if (nextPath) next.nextRenamePath = nextPath;
    else delete next.nextRenamePath;
    await this.setRecord(next, false);
  }

  /**
   * Restores a durable session, if this device had one for the path.
   *
   * A restart is not a fresh start: the room may still hold operations this device owes R2, and the
   * plugin has to know that before it lets the cold path touch the file. Outbox rows from a *previous*
   * epoch are dropped rather than replayed, because the epoch fence on the server would refuse them
   * anyway and a stale update is not an edit this device still owns.
   */
  async restore(): Promise<HotSessionRecord | null> {
    const sessions = await this.deps.store.loadSessions();
    const record = sessions.find(candidate => candidate.canonicalPath === this.deps.canonicalPath) ?? null;
    this.record = record;
    if (!record) return null;
    const entries = await this.deps.store.loadOutbox();
    for (const entry of entries) {
      if (entry.documentId !== record.documentId) continue;
      if (entry.epoch !== record.epoch) {
        await this.deps.store.deleteOutbox(entry.key);
        continue;
      }
      this.outbox.set(entry.key, entry);
    }
    return record;
  }

  /**
   * Acquires hot ownership and opens the session socket.
   *
   * `local` is the caller's own view of the file. The server compares it against the room's content
   * hash and refuses the acquisition when the two are unrelated versions — which is the only honest
   * answer: joining would silently discard whichever side lost.
   */
  async start(input: { local: { contentHash: string; size: number } | null; operationId: string }): Promise<HotAcquireResult> {
    const acquired = await this.deps.client.acquire({
      operationId: input.operationId,
      canonicalPath: this.deps.canonicalPath,
      clientId: this.deps.clientId,
      expected: { state: "unknown" },
      local: input.local,
      wantSession: true,
    });
    return this.adopt(acquired, null);
  }

  /** Re-acquires after a disconnect or a restart, stating the identity this device already holds. */
  async resume(operationId: string, expectedGeneration?: number): Promise<HotAcquireResult> {
    const record = this.record;
    if (!record) throw new HotClientError({ kind: "misconfigured" }, "there is no hot session to resume");
    const localText = this.deps.doc.text();
    const acquired = await this.deps.client.acquire({
      operationId,
      canonicalPath: record.canonicalPath,
      clientId: record.clientId,
      expected: { state: "bound", documentId: record.documentId, epoch: record.epoch },
      local: { contentHash: await hotContentHash(localText), size: localText.length },
      wantSession: true,
    });
    if (expectedGeneration !== undefined && expectedGeneration !== this.lifecycleGeneration) {
      // The user closed the document while acquire was in flight. Do not resurrect the local session;
      // release the just-acquired server claim with the identity it returned.
      if ((acquired.outcome === "joined" || acquired.outcome === "created") && acquired.identity) {
        await this.deps.client.release({
          operationId: `${operationId}-cancel`,
          clientId: record.clientId,
          documentId: acquired.identity.documentId,
          epoch: acquired.identity.epoch,
          checkpoint: false,
          lastAcceptedRevision: record.lastAcceptedRevision,
        }).catch(error => this.debug(`hot cancelled reconnect release failed: ${error instanceof Error ? error.message : "unknown"}`));
      }
      return acquired;
    }
    return this.adopt(acquired, record);
  }

  private async adopt(acquired: HotAcquireResult, previous: HotSessionRecord | null): Promise<HotAcquireResult> {
    if (acquired.outcome === "conflict" || acquired.outcome === "rejected") {
      const reason = acquired.reason ?? acquired.outcome;
      if (previous) await this.setRecord({ ...previous, status: "conflict", updatedAt: this.now() }, false);
      this.events.onConflict?.(reason);
      await this.persist("conflict", reason);
      return acquired;
    }
    const identity = acquired.identity;
    if (!identity || !acquired.sessionTicket || !identity.epoch) {
      this.events.onConflict?.("malformed");
      await this.persist("conflict", "malformed");
      return acquired;
    }
    const next: HotSessionRecord = {
      canonicalPath: acquired.binding?.canonicalPath ?? this.deps.canonicalPath,
      documentId: identity.documentId,
      epoch: identity.epoch,
      clientId: previous?.clientId ?? this.deps.clientId,
      status: "connecting",
      lastAcceptedRevision: previous?.lastAcceptedRevision ?? acquired.serverRevision ?? 0,
      lastCheckpointedRevision: acquired.latestCheckpointedRevision ?? 0,
      pendingSave: false,
      requestedRevision: previous?.requestedRevision ?? null,
      updatedAt: this.now(),
    };
    await this.setRecord(next, false);
    this.connect(acquired.sessionTicket);
    return acquired;
  }

  private connect(ticket: string): void {
    const socket = this.deps.client.connect(ticket);
    this.socket = socket;
    // A reconnect or plugin reload can leave the old transport alive long enough to deliver a queued
    // frame. Only the socket currently owned by this session may mutate its Y.Doc/editor; otherwise a
    // stale same-device operation is indistinguishable from remote input and becomes an event echo.
    socket.onMessage(data => {
      if (this.socket !== socket) return;
      void this.onMessage(data);
    });
    socket.onClose(() => this.onSocketClosed(socket));
  }

  /**
   * Handles an unexpected socket close.
   *
   * A close that arrives while the session is still supposed to be live — i.e. before a deliberate
   * `close()` / `abandon()` / `release()` — must reconnect; otherwise local edits accumulate in the
   * outbox, no remote updates land, and the next visible handoff fails for a reason that looks like
   * "this device never contributed anything" but is really "the socket died and nobody noticed".
   *
   * A successful `resume()` resets the backoff so a stable link is not punished for an early blip; a
   * failed attempt doubles the delay up to the cap, so the loop does not busy-loop a dead gateway.
   */
  private onSocketClosed(socket: HotSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    const record = this.record;
    if (!record) return;
    if (record.status === "closed" || record.status === "handoff-pending" || record.status === "conflict") return;
    void this.persist("disconnected").then(() => this.scheduleReconnect());
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const record = this.record;
    if (!record) return;
    if (record.status === "closed" || record.status === "handoff-pending" || record.status === "conflict") return;
    const delay = this.reconnectDelay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.performReconnect();
    }, delay);
  }

  private cancelReconnect(): void {
    this.lifecycleGeneration += 1;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async performReconnect(): Promise<void> {
    const record = this.record;
    if (!record) return;
    if (record.status === "closed" || record.status === "handoff-pending" || record.status === "conflict") return;
    const generation = this.lifecycleGeneration;
    this.reconnectAttempts += 1;
    try {
      const result = await this.resume(this.nextReconnectOperationId(), generation);
      if (generation !== this.lifecycleGeneration) return;
      if (result.outcome === "joined" || result.outcome === "created") {
        // A live socket means the loop is over. The next unexpected close starts backoff again from
        // the floor — a single failed handshake should not be remembered across hours of editing.
        this.reconnectDelay = this.reconnectInitialDelayMs;
        this.reconnectAttempts = 0;
        return;
      }
      // The server refused with a verdict (conflict / rejected); the room is the authority and the
      // session has already been told. Stop the loop; the user-facing conflict machinery takes over.
      this.debug(`hot reconnect gave up: ${result.outcome}${result.reason ? "/" + result.reason : ""}`);
      this.cancelReconnect();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown";
      this.debug(`hot reconnect attempt ${this.reconnectAttempts} failed: ${detail}`);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxDelayMs);
      this.scheduleReconnect();
    }
  }

  /** Drives one server frame. Exposed so the state machine can be tested without a socket. */
  async handleFrame(frame: HotServerMessage): Promise<void> {
    const record = this.record;
    switch (frame.type) {
      case "welcome": {
        this.observedServerRevision = Math.max(this.observedServerRevision, frame.serverRevision);
        if (!record) return;
        this.deps.doc.applyState(frame.crdtState);
        await this.setRecord({
          ...record,
          canonicalPath: frame.canonicalPath,
          documentId: frame.documentId,
          epoch: frame.epoch,
          lastCheckpointedRevision: Math.max(record.lastCheckpointedRevision, frame.latestCheckpointedRevision),
          pendingSave: frame.pendingSave || record.lastAcceptedRevision > frame.latestCheckpointedRevision,
          status: frame.state === "active" ? "hot" : frame.state === "conflicted" ? "conflict" : "handoff-pending",
          updatedAt: this.now(),
        });
        this.flush();
        return;
      }
      case "operation": {
        this.observedServerRevision = Math.max(this.observedServerRevision, frame.serverRevision);
        // The Gateway normally suppresses an operation for every socket belonging to its source
        // client. Keep the identity check here as a protocol boundary as well: rolling deployments,
        // reconnect overlap, or an older Gateway must never turn our own Yjs update into a remote
        // editor write and then back into a new local operation.
        if (record && frame.clientId === record.clientId) {
          this.debug(`ignored echoed hot operation ${frame.clientOperationId}`);
          return;
        }
        this.deps.doc.applyRemote(frame.update);
        return;
      }
      case "ack": {
        if (!record) return;
        await this.deps.store.deleteOutbox(outboxKey(frame.documentId, frame.epoch, frame.clientOperationId));
        for (const [key, entry] of this.outbox) {
          if (entry.clientOperationId === frame.clientOperationId && entry.epoch === frame.epoch) this.outbox.delete(key);
        }
        await this.setRecord({
          ...record,
          lastAcceptedRevision: Math.max(record.lastAcceptedRevision, frame.serverRevision),
          pendingSave: true,
          status: record.status === "connecting" ? "hot" : record.status,
          updatedAt: this.now(),
        });
        return;
      }
      case "reject": {
        this.debug(`hot operation rejected reason=${frame.reason}`);
        /**
         * The outbox row's fate depends on the verdict, not on the rejection itself.
         *
         * `stale-epoch`, `unauthorized`, and `unknown-document` mean *this device's* document identity is
         * wrong now: the room has moved on or no longer recognises this client, and replaying the edit
         * would silently diverge the local Y.Doc from whatever the server actually holds. Dropping the
         * row and surfacing the verdict is honest. So is `quiescing` — the room is handing off and will
         * reject anything we send for a moment, which a close+drain already covers.
         *
         * Everything else (`too-large`, transient `overloaded`, a rate-limit `retry`) is a verdict on
         * the *packet*, not on the document. The edit itself still belongs to this user, the Y.Doc has
         * already absorbed it, and the cold path's handoff verification will catch a row that never
         * lands. Removing the row here is what produced the silent permanent fork in the field: the
         * document kept the keystrokes, the server never did, and the next editor-change found nothing
         * to push.
         */
        // A reject is not an acknowledgement. The row is the only durable evidence of the user's edit,
        // so every rejection keeps it; identity/payload verdicts freeze the path for a decision, while
        // the one transient verdict reconnects and retries the same operation id.
        this.debug(`hot operation kept in outbox after reject reason=${frame.reason}`);
        if (frame.reason === "quiescing") {
          await this.persist("handoff-pending", "quiescing");
        } else if (frame.reason === "unavailable") {
          await this.persist("disconnected", "unavailable");
          const socket = this.socket;
          if (socket) {
            try { socket.close(1012, "retry"); } catch { this.scheduleReconnect(); }
          } else this.scheduleReconnect();
        } else {
          this.events.onConflict?.(frame.reason);
          await this.persist("conflict", frame.reason);
        }
        return;
      }
      case "checkpoint": {
        this.lastReceipt = frame;
        if (!record) return;
        await this.setRecord({
          ...record,
          lastCheckpointedRevision: Math.max(record.lastCheckpointedRevision, frame.latestCheckpointedRevision),
          pendingSave: frame.latestAcceptedRevision > frame.latestCheckpointedRevision,
          updatedAt: this.now(),
        });
        this.events.onCheckpoint?.(frame);
        this.resolveWaiters({ receipt: frame });
        return;
      }
      case "document-state": {
        if (frame.state === "deleted") {
          await this.persist("closed", "deleted");
          this.events.onDeleted?.();
          this.resolveWaiters({ failure: "deleted" });
          return;
        }
        if (frame.state === "conflicted") {
          this.events.onConflict?.(frame.reason ?? "conflict");
          await this.persist("conflict", frame.reason ?? "conflict");
          this.resolveWaiters({ failure: frame.reason ?? "conflict" });
          return;
        }
        if (frame.state === "quiescing") {
          await this.persist("handoff-pending", frame.reason ?? "quiescing");
          this.resolveWaiters({ failure: frame.reason ?? "quiescing" });
          return;
        }
        // `active`: a rename, or a conflict that was resolved on the server. The document is the same
        // one; only the path and possibly the epoch moved, and the epoch is what makes old packets
        // unapplyable.
        if (record) {
          if (frame.canonicalPath && frame.canonicalPath !== record.canonicalPath) {
            await this.adoptRename(frame.canonicalPath, frame.epoch);
            this.events.onStatus?.("hot");
          } else {
            await this.setRecord({ ...record, epoch: frame.epoch, status: "hot", updatedAt: this.now() });
          }
        }
        return;
      }
      case "error": {
        this.debug(`hot gateway error code=${frame.code}`);
        return;
      }
      default:
        return;
    }
  }

  private async onMessage(data: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      this.debug("hot frame was not JSON");
      return;
    }
    const frame = parsed as HotServerMessage;
    if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return;
    await this.handleFrame(frame);
  }

  private resolveWaiters(outcome: { receipt: CheckpointReceipt } | { failure: string }): void {
    const remaining: ReceiptWaiter[] = [];
    for (const waiter of this.waiters) {
      if ("receipt" in outcome && outcome.receipt.documentRevision < waiter.minRevision) {
        remaining.push(waiter);
        continue;
      }
      waiter.resolve(outcome);
    }
    this.waiters = remaining;
  }

  /**
   * Stops the in-process transport without changing the durable session lifecycle.
   *
   * Plugin unload is not a handoff: Obsidian may reload the plugin a moment later and the persisted
   * session is what lets that new instance resume. It is, however, a hard ownership boundary for the
   * old JavaScript instance. Leaving its raw WebSocket alive lets the room relay the new instance's
   * operations back through the old socket, producing a same-device event echo.
   */
  shutdown(): void {
    this.cancelReconnect();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(1000, "plugin-unload"); } catch { /* the process is already tearing down */ }
    }
    this.resolveWaiters({ failure: "plugin-unload" });
  }

  /**
   * Persists one local edit and sends it.
   *
   * The outbox row is written first and deleted only on the acknowledgement, so the durable record
   * always contains exactly what the server has not confirmed. If the durable write throws, the in-memory
   * row is rolled back and the error is re-thrown: a caller that drops the promise would lose the edit
   * outright, since `sendOperation` only sees what is in the map.
   */
  async applyLocalUpdate(update: string, clientOperationId: string): Promise<void> {
    const barrier = this.namespaceBarrier;
    if (barrier) await barrier;
    const record = this.record;
    if (!record) return;
    const entry: HotOutboxEntry = {
      key: outboxKey(record.documentId, record.epoch, clientOperationId),
      canonicalPath: record.canonicalPath,
      documentId: record.documentId,
      epoch: record.epoch,
      clientId: record.clientId,
      clientOperationId,
      update,
      createdAt: this.now(),
      attempts: 0,
    };
    this.outbox.set(entry.key, entry);
    try {
      await this.deps.store.putOutbox(entry);
    } catch (error) {
      // The editor and Y.Doc already contain this update. Keep the volatile copy, freeze the path, and
      // surface the failure; deleting it here would make the next diff believe the edit was delivered.
      this.events.onConflict?.("outbox-unavailable");
      if (this.record) {
        this.record = { ...this.record, status: "conflict", updatedAt: this.now() };
        try { await this.deps.store.putSession(this.record); } catch { /* the in-memory fence still holds */ }
        this.events.onStatus?.("conflict", "outbox-unavailable");
      }
      throw error;
    }
    this.sendOperation(entry);
  }

  private sendOperation(entry: HotOutboxEntry): void {
    const socket = this.socket;
    const record = this.record;
    if (!socket || !record || record.status === "closed") return;
    const next: HotOutboxEntry = { ...entry, attempts: entry.attempts + 1 };
    this.outbox.set(next.key, next);
    try {
      socket.send(JSON.stringify({
        protocol: 1,
        type: "operation",
        documentId: record.documentId,
        epoch: record.epoch,
        clientId: record.clientId,
        clientOperationId: next.clientOperationId,
        update: next.update,
        parentRevision: record.lastAcceptedRevision,
      }));
    } catch (error) {
      this.debug(`hot send failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  /** Re-sends everything unacknowledged. Safe by construction: the server deduplicates by operation id. */
  flush(): number {
    const entries = this.pending();
    for (const entry of entries) this.sendOperation(entry);
    return entries.length;
  }

  /**
   * A receipt that covers `minRevision`, or `undefined` when none arrived.
   *
   * `undefined` covers three different situations — a timeout, a conflict, and a room that started
   * quiescing — and the caller must treat them identically: the save is unconfirmed, so cold sync may
   * not take the path back.
   */
  async requestCheckpoint(minRevision: number): Promise<CheckpointReceipt | undefined> {
    if (this.lastReceipt && this.lastReceipt.documentRevision >= minRevision) return this.lastReceipt;
    const record = this.record;
    const socket = this.socket;
    if (!record || !socket) return undefined;
    const pending = new Promise<{ receipt: CheckpointReceipt } | { failure: string }>(resolve => {
      this.waiters.push({ minRevision, resolve });
    });
    const timeout = new Promise<{ failure: string }>(resolve => {
      setTimeout(() => resolve({ failure: "timeout" }), this.receiptTimeoutMs);
    });
    try {
      socket.send(JSON.stringify({
        protocol: 1,
        type: "checkpoint-request",
        documentId: record.documentId,
        epoch: record.epoch,
        clientId: record.clientId,
        clientOperationId: `cp-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        upToRevision: minRevision,
      }));
    } catch {
      return undefined;
    }
    const outcome = await Promise.race([pending, timeout]);
    return "receipt" in outcome ? outcome.receipt : undefined;
  }

  /** Waits, bounded, for the outbox to become empty. */
  async drain(timeoutMs = this.drainTimeoutMs): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    while (this.pending().length > 0 && this.now() < deadline) {
      this.flush();
      await new Promise(resolve => setTimeout(resolve, this.drainStepMs));
    }
    return this.pending().length === 0;
  }

  /**
   * Ends the session and hands the path back to the cold path.
   *
   * The order *is* the guarantee: everything acknowledged is first made durable locally, the handoff
   * intent is written before it is attempted, the checkpoint has to name a revision that covers this
   * device's work, the local bytes have to *be* that revision, and only then is ownership released. A
   * failure at any step leaves a durable handoff record and fences cold sync — never a silent claim
   * that everything is saved.
   */
  /**
   * Stops the session on purpose: no handoff, no checkpoint, no release round trip.
   *
   * One caller exists — the user accepting the remote version of a conflict. This device stops being an
   * authority for the path, so the release request would be a courtesy the room does not need (its own
   * socket close is what tells it the client is gone). The local file stays exactly where it is, and the
   * cold path reconciles it against R2 with its ordinary rules, including raising a *cold* conflict if
   * the two still disagree. That is the right place for that decision: by then both versions are
   * observable, which is precisely what was missing while the path was frozen.
   */
  abandon(): void {
    const socket = this.socket;
    this.socket = null;
    this.cancelReconnect();
    if (socket) {
      try { socket.close(1000, "abandoned"); } catch { /* already closing */ }
    }
  }

  /**
   * Marks the session as terminally frozen and tears down the live socket.
   *
   * `freeze()` is the response to an internal invariant failure: the editor bridge proved it can no
   * longer keep the buffer in agreement with the Y.Doc, and continuing to consume incoming frames —
   * even buffered — would silently advance the room's authoritative state past the diagnostic scene
   * we need to recover from. The socket is closed (the room sees the client leave on purpose), no
   * reconnect is scheduled, and the session record is persisted with the freeze reason so the
   * resolver and the next plugin run can both see *why* this path was taken out of service.
   *
   * A frozen session is not reusable. The resolver must close + reopen (or `forget()` and let the
   * next `open()` build a fresh binding on the user's chosen baseline) — see the conflict-design
   * `editor-document-divergence` lifecycle in `coordinator.ts`.
   */
  async freeze(reason: string): Promise<void> {
    this.cancelReconnect();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(1011, "frozen"); } catch { /* already closing */ }
    }
    if (this.record) {
      this.record = { ...this.record, status: "conflict", updatedAt: this.now() };
      await this.deps.store.putSession(this.record);
    }
    this.events.onStatus?.("conflict", reason);
  }

  async close(input: { checkpoint: boolean; localText: string; operationId: string }): Promise<HotCloseOutcome> {
    const record = this.record;
    if (!record) return { outcome: "not-hot" };
    // The close is intentional; the reconnect loop must not resurrect the socket on the way out.
    this.cancelReconnect();
    await this.drain();
    const current = this.record;
    if (!current) return { outcome: "not-hot" };
    const required = current.lastAcceptedRevision;
    const handoff: HotHandoffRecord = {
      canonicalPath: current.canonicalPath,
      documentId: current.documentId,
      epoch: current.epoch,
      requiredRevision: required,
      contentHash: await hotContentHash(input.localText),
      r2ETag: null,
      createdAt: this.now(),
    };
    // Written before the attempt: a crash here leaves the fence up, which is the safe direction.
    await this.deps.store.putHandoff(handoff);
    await this.persist("handoff-pending");

    let receipt = this.lastReceipt && this.lastReceipt.documentRevision >= required ? this.lastReceipt : undefined;
    // A revision that was never produced needs no receipt: asking for one would be a round trip for
    // nothing, and the server would answer "nothing to save" anyway.
    const needsCover = required > current.lastCheckpointedRevision;
    if (!receipt && needsCover && (input.checkpoint || current.pendingSave)) {
      receipt = await this.requestCheckpoint(required);
    }
    if (!receipt && input.checkpoint && needsCover) {
      return { outcome: "handoff-pending", detail: "no-receipt" };
    }
    if (receipt) {
      const localHash = await hotContentHash(input.localText);
      if (receipt.contentHash !== localHash) {
        // The server saved a revision this file is not. That is a real divergence, and calling it a
        // completed handoff would hand cold sync a baseline for bytes that do not match.
        this.debug("hot handoff pending: local content is not the checkpointed revision");
        return { outcome: "handoff-pending", receipt, detail: "content-mismatch" };
      }
      handoff.contentHash = receipt.contentHash;
      handoff.r2ETag = receipt.r2ETag;
      await this.deps.store.putHandoff(handoff);
    }

    try {
      // A release is idempotent, so a short bounded retry is safe and it covers the common race: the
      // other device closed a moment ago and the room has not processed its socket close yet. Only a
      // *live* peer keeps this device waiting, and then `remainingClients` stays above zero and the
      // answer is `saved-hot-elsewhere`.
      let released = await this.deps.client.release({
        operationId: input.operationId,
        clientId: current.clientId,
        documentId: current.documentId,
        epoch: current.epoch,
        checkpoint: input.checkpoint,
        lastAcceptedRevision: required,
      });
      for (let attempt = 1; attempt < this.releaseAttempts && released.outcome !== "released" && (released.remainingClients ?? 0) > 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, this.releaseRetryDelayMs));
        released = await this.deps.client.release({
          operationId: `${input.operationId}-r${attempt}`,
          clientId: current.clientId,
          documentId: current.documentId,
          epoch: current.epoch,
          checkpoint: false,
          lastAcceptedRevision: required,
        });
      }
      if (released.outcome !== "released") {
        // A verified receipt means *this* device's work is saved even when the path is not free yet:
        // another client still holds the document, and its session is what keeps the fence up here.
        if (receipt && (released.remainingClients ?? 0) > 0) {
          // This device's handoff is finished, so its pending-handoff record goes away; the path stays
          // fenced because the *document* is still owned, which is a different thing and is what the
          // session's own record now says.
          await this.deps.store.deleteHandoff(handoff.canonicalPath);
          if (this.socket) {
            try { this.socket.close(1000, "released"); } catch { /* already closing */ }
            this.socket = null;
          }
          await this.persist("disconnected", "hot-elsewhere");
          return { outcome: "saved-hot-elsewhere", receipt, detail: "remaining-clients" };
        }
        return { outcome: "handoff-pending", ...(receipt ? { receipt } : {}), detail: released.outcome };
      }
    } catch (error) {
      const detail = error instanceof HotClientError ? error.failure.kind : error instanceof Error ? error.message : "unknown";
      this.debug(`hot release failed: ${detail}`);
      return { outcome: "handoff-pending", ...(receipt ? { receipt } : {}), detail };
    }

    await this.deps.store.deleteHandoff(handoff.canonicalPath);
    if (this.socket) {
      try { this.socket.close(1000, "handoff"); } catch { /* already closing */ }
      this.socket = null;
    }
    await this.persist("closed");
    return { outcome: "handed-off", ...(receipt ? { receipt } : {}) };
  }

  /** The cold baseline a completed handoff earns. */
  baselineFrom(receipt: CheckpointReceipt): HotBaseline {
    return {
      canonicalPath: receipt.canonicalPath,
      contentHash: receipt.contentHash,
      r2ETag: receipt.r2ETag,
      documentRevision: receipt.documentRevision,
      checkpointedAt: receipt.checkpointedAt,
    };
  }
}
