import type { HotResolutionSnapshot, HotMergedResolutionResult } from "@mineral/sync-core/hot-protocol";
import type { Editor } from "obsidian";
import { hotContentHash, type HotAcquireResult, type HotRemoteObservation, type PathBinding } from "@mineral/sync-core/hot-protocol";
import type { NamespaceIntent, NamespaceResult } from "@mineral/sync-core/namespace-protocol";
import type { HotGatewayClient, HotPathStatus } from "./client";
import { HotEditorBinding } from "./editor-binding";
import { HeadlessEditor, asEditor } from "./headless-editor";
import type { HotStateStore } from "./store";
import { HotDocumentSession, type HotCloseOutcome } from "./session";
import { sessionStatusFencesCold, sessionStatusIsOperational, type HotBaseline, type HotSessionRecord, type HotSessionStatus } from "./types";
import { pathDigest } from "../sync/path";

/**
 * The plugin's hot-path owner: which paths are hot, what the cold path may touch, and how a document
 * is opened and handed back.
 *
 * It is also the single implementation of the cold-execution fence. Hot ownership and cold mutation
 * are two authorities over one file, so the question "may the planner/executor touch this path?"
 * has exactly one answer, and it comes from here — not from a `Set<string>` that a plugin reload
 * would empty.
 */

export type HotFenceReason = "hot" | "handoff-pending" | "conflict";

export interface HotPathFence {
  /** `null` when the cold path may touch this path; otherwise why it may not. */
  fenceReason(canonicalPath: string): HotFenceReason | null;
  isFenced(canonicalPath: string): boolean;
  fencedPaths(): string[];
  /**
   * The vocabulary the cold planner uses: a hot path is not missing, it is deferred, and it may never
   * become a deletion inference or a baseline GC.
   */
  plannerFact(canonicalPath: string): "deferred-by-hot-ownership" | null;
}

export interface HotCoordinatorDependencies {
  client: HotGatewayClient;
  store: HotStateStore;
  /** Stable device identity; the server scopes operation deduplication to it. */
  clientId: string;
  now?: () => number;
  /** Commits the cold baseline a completed handoff earns. */
  commitBaseline?(canonicalPath: string, baseline: HotBaseline): Promise<void>;
  onStatus?(canonicalPath: string, status: HotSessionStatus, detail?: string): void;
  onConflict?(canonicalPath: string, reason: string): void;
  /** Reads the current bytes of a path; the resolution path needs the version the user is looking at. */
  readLocalText?(canonicalPath: string): Promise<string | undefined>;
  /** Writes the chosen version back to the file, when a resolution has to make the file match the room. */
  writeLocalText?(canonicalPath: string, text: string): Promise<void>;
  /**
   * Captures a pane's scroll position before a write to it, returning the restore.
   *
   * A hot session writes into the buffer whenever a remote edit lands, and writing moves the viewport — so
   * without this the reader's place is lost every time somebody else types.
   */
  preserveViewport?(canonicalPath: string): (() => void) | undefined;
  /** Applies a room-originated namespace rename to the local Vault/UI owner. */
  onRenamed?(fromPath: string, toPath: string): void | Promise<void>;
  /** A human decision landed; the caller asks the cold path to look at the path again. */
  onResolved?(canonicalPath: string, decision: "keep-local" | "accept-remote" | "merged"): void;
  debug?(message: string): void;
}

/**
 * Why a path is frozen for a human.
 *
 * `external-local-edit` is this device's own finding (something wrote the file under the editor), while
 * `conflict` and `handoff-pending` come from the authority — an external writer won, R2 lost the
 * revision, or a handoff never completed.
 */
export type HotConflictReason = "external-local-edit" | "conflict" | "handoff-pending";

export type HotOpenOutcome = {
  outcome: "hot" | "conflict" | "rejected" | "unsupported";
  reason?: string;
  session?: HotDocumentSession;
  binding?: PathBinding | null;
  identity?: { documentId: string; epoch: number };
  remote?: HotRemoteObservation | null;
};

let operationCounter = 0;

export class HotSyncCoordinator implements HotPathFence {
  private readonly sessions = new Map<string, HotDocumentSession>();
  private readonly openingPaths = new Map<string, number>();
  private dormantRecovery?: Promise<number>;
  private readonly bindings = new Map<string, HotEditorBinding>();
  private readonly hotPaths = new Set<string>();
  private readonly handoffPaths = new Set<string>();
  private readonly conflicts = new Map<string, HotConflictReason>();
  /**
   * Why a path is conflicted, in the terms a resolution needs.
   *
   * `mismatch` means the document already holds a different revision, so the two sides have to be made to
   * agree; `room` means the authority refused a write and has to be re-pointed. The map the UI reads stays
   * two-valued on purpose — a user does not need this distinction, but the resolution cannot work without
   * it.
   */
  private readonly conflictOrigins = new Map<string, "mismatch" | "room">();
  /**
   * Paths the server could not serve, by path. Deliberately *not* part of the conflict list: there is
   * nothing for the user to decide, and presenting it as a conflict is what made a stuck path look like a
   * question the user kept answering wrong.
   */
  private readonly unavailable = new Map<string, string>();
  private readonly deferred = new Map<string, number>();
  /** Cold-mutation leases this device holds right now, by path. */
  private readonly coldLeases = new Map<string, { token: string; operationId: string; operation: "put" | "delete" }>();
  private readonly pendingRenames = new Map<string, { intent: Extract<NamespaceIntent, { type: "rename" }>; finish?: () => void; nextPath?: string }>();
  private renameRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private renameRetryRunning = false;
  private stopped = false;
  private readonly reservedRenamePaths = new Set<string>();

  constructor(private readonly deps: HotCoordinatorDependencies) {}

  private nextOperationId(prefix: string): string {
    operationCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${operationCounter.toString(36)}`;
  }

  /**
   * Loads the durable picture.
   *
   * Until this finishes, nothing may assume a path is cold: a restart with a pending handoff must
   * fence that path from the very first cold cycle, not from the first time someone opens it.
   */
  async restore(): Promise<{ sessions: HotSessionRecord[]; handoffs: number }> {
    const sessions = await this.deps.store.loadSessions();
    const handoffs = await this.deps.store.loadHandoffs();
    for (const record of sessions) {
      if (record.pendingRename) {
        this.pendingRenames.set(record.pendingRename.operationId, { intent: record.pendingRename, nextPath: record.nextRenamePath });
        if (record.nextRenamePath) this.reservedRenamePaths.add(record.nextRenamePath);
      }
      if (record.status === "closed") {
        await this.deps.store.deleteSession(record.canonicalPath);
        continue;
      }
      if (record.status === "conflict") this.conflicts.set(record.canonicalPath, "conflict");
      if (record.status === "handoff-pending") this.handoffPaths.add(record.canonicalPath);
      else this.hotPaths.add(record.canonicalPath);
    }
    for (const handoff of handoffs) this.handoffPaths.add(handoff.canonicalPath);
    if (this.pendingRenames.size) this.scheduleRenameRecovery();
    this.deps.debug?.(`hot restore: sessions=${sessions.length} handoffs=${handoffs.length}`);
    return { sessions, handoffs: handoffs.length };
  }

  /* --------------------------------------------------------------------------------------------
   * The cold fence
   * ------------------------------------------------------------------------------------------ */

  fenceReason(canonicalPath: string): HotFenceReason | null {
    if (this.hasPendingRename(canonicalPath)) return "handoff-pending";
    if (this.conflicts.has(canonicalPath)) return "conflict";
    if (this.handoffPaths.has(canonicalPath)) return "handoff-pending";
    const session = this.sessions.get(canonicalPath);
    if (session && sessionStatusFencesCold(session.status)) return "hot";
    if (this.hotPaths.has(canonicalPath)) return "hot";
    return null;
  }

  isFenced(canonicalPath: string): boolean {
    return this.fenceReason(canonicalPath) !== null;
  }

  /**
   * Whether the cold path may run **this** operation for the path.
   *
   * Several cold operations can write a path, and only one of them is the answer to a frozen conflict. A
   * resolved merge is the user's decision, already recorded and bound to the exact versions they were
   * shown (`resolve-merged` carries `expectedLocal` and `expectedRemoteETag`, and the executor re-checks
   * both), so the fence has nothing left to protect — the thing it was holding the path for has happened.
   *
   * Without this the path deadlocks, and no decision can ever finish it:
   *
   * - the conflict is a session record read back from disk, so `fenceReason` says `conflict` twice over —
   *   once through `this.conflicts`, once through `sessionStatusFencesCold("conflict")`;
   * - the cold side owns the version-bound intent and the executor that could apply it, but cannot run;
   * - the hot side can only be resolved by writing *through a room*, which for a path with no live binding
   *   means re-joining one — and the user has no reason to go looking there, because the conflict they can
   *   see is the one the cold resolver lists.
   *
   * The exception is deliberately narrow. `external-local-edit` never yields: its session is perfectly
   * live — something wrote the file underneath a *bound editor* — so the room is still a writer and the
   * cold side must not race it. It yields only for a conflict that means the room was **refused** and has
   * no live pane behind it, and never for an upload, download or delete: those carry no decision that
   * could justify letting them past the fence.
   *
   * A binding alone is not "live". `open()` registers one before the acquire handshake finishes and leaves
   * it there if the join is refused, so a path can hold a binding whose room never published anything.
   * That is not a writer, and treating it as one is what leaves the decision with nowhere to land.
   *
   * A *restored* record is not a live session either: `restore()` rebuilds the fence from the path sets
   * (`this.conflicts`, `this.handoffPaths`, `this.hotPaths`) and deliberately does not put it back in
   * `this.sessions`, because there is no socket, no editor and no room behind it. So the only sessions
   * that can be operational here are ones an `open()` created in this run.
   */
  isFencedFor(canonicalPath: string, operation: string): boolean {
    const reason = this.fenceReason(canonicalPath);
    if (reason === null) return false;
    if (reason !== "conflict" || operation !== "resolve-merged") return true;
    // The session is the writer, not the binding: `hot`-family statuses are the ones that publish.
    const status = this.sessions.get(canonicalPath)?.session?.status;
    return status !== undefined && sessionStatusIsOperational(status);
  }

  fencedPaths(): string[] {
    return [...new Set([...this.hotPaths, ...this.handoffPaths, ...this.conflicts.keys(), ...this.reservedRenamePaths, ...[...this.pendingRenames.values()].flatMap(({ intent }) => [intent.fromPath, intent.toPath])])];
  }

  plannerFact(canonicalPath: string): "deferred-by-hot-ownership" | null {
    return this.isFenced(canonicalPath) ? "deferred-by-hot-ownership" : null;
  }

  /** Retained ownership without a socket must eventually return to ordinary reconciliation. */
  reconcileDormantOwnership(): Promise<number> {
    if (this.dormantRecovery) return this.dormantRecovery;
    const task = this.recoverDormantOwnership();
    this.dormantRecovery = task;
    void task.finally(() => { if (this.dormantRecovery === task) this.dormantRecovery = undefined; }).catch(() => undefined);
    return task;
  }

  private async recoverDormantOwnership(): Promise<number> {
    const [records, outbox, handoffs] = await Promise.all([
      this.deps.store.loadSessions(), this.deps.store.loadOutbox(), this.deps.store.loadHandoffs(),
    ]);
    let released = 0;
    for (const record of records) {
      const path = record.canonicalPath;
      if (record.pendingRename || this.hasPendingRename(path)) continue;
      if (!this.isFenced(path) || this.openingPaths.has(path) || this.sessions.has(path) || this.bindings.has(path)
        || this.conflicts.has(path) || this.handoffPaths.has(path) || record.pendingSave
        || record.lastAcceptedRevision > record.lastCheckpointedRevision
        || handoffs.some(entry => entry.canonicalPath === path)
        || outbox.some(entry => entry.canonicalPath === path)) continue;
      let status: HotPathStatus;
      try { status = await this.deps.client.pathStatus(path); }
      catch { continue; }
      const room = status.room;
      // A query failure, a different incarnation, another client or unsaved work cannot earn release.
      if (status.hotOwned || !status.binding || status.binding.documentId !== record.documentId
        || status.binding.epoch !== record.epoch || status.binding.state !== "active"
        || !room || room.state !== "active" || room.clients !== 0 || room.pendingSave
        || room.latestAcceptedRevision > room.latestCheckpointedRevision) continue;
      // The query awaited the network: opening this path meanwhile must keep its fence.
      if (this.openingPaths.has(path) || this.sessions.has(path) || this.bindings.has(path) || this.conflicts.has(path)
        || this.handoffPaths.has(path)) continue;
      await this.deps.store.deleteSession(path);
      this.hotPaths.delete(path);
      this.deferred.delete(path);
      released += 1;
      this.deps.debug?.(`hot dormant ownership released path-digest=${pathDigest(path)}`);
    }
    return released;
  }

  /**
   * Records that a cold operation was skipped because the path is hot.
   *
   * The count is diagnostic rather than corrective: it exists so the status UI can say "3 changes are
   * waiting for a hot handoff" instead of silently doing nothing.
   */
  noteDeferred(canonicalPath: string): void {
    this.deferred.set(canonicalPath, (this.deferred.get(canonicalPath) ?? 0) + 1);
  }

  deferredSummary(): { paths: number; operations: number } {
    return { paths: this.deferred.size, operations: [...this.deferred.values()].reduce((total, count) => total + count, 0) };
  }

  /** Terminates every live in-process bridge and socket when the plugin instance is unloaded. */
  shutdown(): void {
    this.stopped = true;
    if (this.renameRetryTimer) clearTimeout(this.renameRetryTimer);
    for (const binding of this.bindings.values()) binding.detach();
    for (const session of this.sessions.values()) session.shutdown();
    this.bindings.clear();
    this.sessions.clear();
  }

  /* --------------------------------------------------------------------------------------------
   * Document lifecycle
   * ------------------------------------------------------------------------------------------ */

  sessionFor(canonicalPath: string): HotDocumentSession | undefined {
    return this.sessions.get(canonicalPath);
  }

  bindingFor(canonicalPath: string): HotEditorBinding | undefined {
    return this.bindings.get(canonicalPath);
  }

  /** Moves every client-side responsibility for one document to its authoritative new path. */
  private async relocateSession(
    session: HotDocumentSession,
    binding: HotEditorBinding,
    route: { canonicalPath: string },
    toPath: string,
  ): Promise<void> {
    const fromPath = route.canonicalPath;
    if (fromPath === toPath) return;
    route.canonicalPath = toPath;
    if (this.bindings.get(fromPath) === binding) this.bindings.delete(fromPath);
    this.bindings.set(toPath, binding);
    if (this.sessions.get(fromPath) === session) this.sessions.delete(fromPath);
    this.sessions.set(toPath, session);
    this.hotPaths.delete(fromPath);
    this.hotPaths.add(toPath);
    if (this.handoffPaths.delete(fromPath)) this.handoffPaths.add(toPath);
    const conflict = this.conflicts.get(fromPath);
    if (conflict) { this.conflicts.delete(fromPath); this.conflicts.set(toPath, conflict); }
    const origin = this.conflictOrigins.get(fromPath);
    if (origin) { this.conflictOrigins.delete(fromPath); this.conflictOrigins.set(toPath, origin); }
    await this.deps.onRenamed?.(fromPath, toPath);
  }

  /**
   * Opens a document for hot editing.
   *
   * The caller has already produced the binding and applied nothing: acquisition comes first, because
   * a local file whose content is not a version the room knows must *not* be merged in. That decision
   * belongs to the server, and `conflict` is its answer.
   */
  async open(input: { canonicalPath: string; editor: Editor; localText: string; adoptRemote?: boolean; isCurrent?: () => boolean }): Promise<HotOpenOutcome> {
    const path = input.canonicalPath;
    this.openingPaths.set(path, (this.openingPaths.get(path) ?? 0) + 1);
    try {
      await this.dormantRecovery;
      return await this.openInternal(input);
    }
    finally {
      const remaining = (this.openingPaths.get(path) ?? 1) - 1;
      if (remaining > 0) this.openingPaths.set(path, remaining);
      else this.openingPaths.delete(path);
    }
  }

  private async openInternal(input: { canonicalPath: string; editor: Editor; localText: string; adoptRemote?: boolean; isCurrent?: () => boolean }): Promise<HotOpenOutcome> {
    const existing = this.sessions.get(input.canonicalPath);
    if (existing) return { outcome: "hot", session: existing };

    // `adoptRemote` claims nothing about local content: the server then hands over the document instead of
    // refusing a join it cannot verify, which is the first half of every mismatch resolution.
    const local = input.adoptRemote ? null : { contentHash: await hotContentHash(input.localText), size: input.localText.length };
    const route = { canonicalPath: input.canonicalPath };
    let session!: HotDocumentSession;
    const binding = new HotEditorBinding({
      editor: input.editor,
      ...(this.deps.preserveViewport ? { preserveViewport: () => this.deps.preserveViewport!(route.canonicalPath) } : {}),
      // The session is registered before anything can edit through the binding (see below), so this
      // lookup is what delivers the seed. It used to be registered *after* the seed, which quietly threw
      // the first content of every brand-new hot note away: the binding inserted it into the document,
      // found no session to send it to, and the note reached R2 only if somebody later happened to type.
      onLocalUpdate: (update, operationId) => {
        if (!session) {
          this.deps.debug?.("hot local update dropped: the session is not registered yet");
          return;
        }
        /**
         * The contract is "persist before send" — so the durability of an edit must not depend on the
         * caller awaiting it. Surfacing the error keeps a failed outbox write from looking like a
         * successful keystroke: a transient IndexedDB failure ends up at the diagnostic log instead of
         * silently leaving the Y.Doc ahead of the durable record. The session's own catch around
         * `putOutbox` is what protects against the inverse direction.
         */
        return session.applyLocalUpdate(update, operationId).catch(error => {
          this.deps.debug?.(`hot outbox write failed: ${error instanceof Error ? error.message : "unknown"}`);
          throw error;
        });
      },
      /**
       * A frozen bridge means the editor and the Y.Doc cannot be reconciled by a regular editor
       * transaction. Continuing to translate further updates would extend the divergence forever, and
       * the next user keystroke would push the wrong content out to the room. The honest answer is a
       * conflict the user can act on: we mark the path conflicted, surface the freeze reason in the
       * diagnostics, refuse to generate further operations until the user resolves it — and tear down
       * the live socket so the room does not continue to apply Yjs updates that the bridge can no
       * longer project. Recovery goes through `editor-document-divergence`, not the ordinary
       * `keep-local` / `accept-remote` resolver, because the bridge's invariant has been broken, not
       * the user's content.
       */
      onFreeze: (reason) => {
        const path = route.canonicalPath;
        this.conflicts.set(path, "conflict");
        this.conflictOrigins.set(path, "mismatch");
        this.hotPaths.delete(path);
        this.handoffPaths.add(path);
        this.deps.debug?.(`hot freeze path-digest=${pathDigest(path)} reason=${reason}`);
        this.deps.onConflict?.(path, "editor-document-divergence");
        // Tear down the live session: no more reconnects, no more incoming `operation` frames that
        // would otherwise keep advancing the Y.Doc past the diagnostic scene the resolver needs.
        if (session) {
          void session.freeze(`editor-document-divergence: ${reason}`).catch(error => {
            this.deps.debug?.(`hot freeze persist failed: ${error instanceof Error ? error.message : "unknown"}`);
          });
        }
      },
      debug: this.deps.debug,
    });
    session = new HotDocumentSession({
      client: this.deps.client,
      store: this.deps.store,
      doc: binding,
      clientId: this.deps.clientId,
      canonicalPath: input.canonicalPath,
      events: {
        onStatus: (status, detail) => {
          const path = route.canonicalPath;
          if (status === "hot") this.hotPaths.add(path);
          if (status === "handoff-pending") {
            this.handoffPaths.add(path);
            this.hotPaths.delete(path);
          }
          // The nuanced reason stays in the session record (`statusOf().reason`); the map only classifies
          // it for the fence and for the resolution UI, which treats every server-side cause the same way.
          if (status === "conflict") this.conflicts.set(path, "conflict");
          this.deps.onStatus?.(path, status, detail);
        },
        onConflict: reason => {
          // Every cause the server reports is, for this device's purposes, the same kind of fact: the
          // authority refused the write and the path needs a human. The exact reason is preserved in the
          // session record, which is what `statusOf` and the resolver's message read.
          const path = route.canonicalPath;
          this.conflicts.set(path, "conflict");
          this.deps.onConflict?.(path, reason);
        },
        onDeleted: () => {
          const path = route.canonicalPath;
          this.hotPaths.delete(path);
          this.bindings.delete(path);
          this.sessions.delete(path);
        },
        onRenamed: (fromPath, toPath) => this.relocateSession(session, binding, route, toPath),
        debug: this.deps.debug,
      },
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
    const restored = await session.restore();
    const acquired: HotAcquireResult = restored
      ? await session.resume(this.nextOperationId("resume"))
      : await session.start({ local, operationId: this.nextOperationId("acquire") });

    if (acquired.outcome === "rejected") {
      // "Unavailable" is not a disagreement about content, and offering the user a choice cannot fix it:
      // the server simply could not serve the path (an R2 read that failed, or material it needed and did
      // not get). Listing it beside real conflicts produced a loop of unresolvable "conflicts" that no
      // decision could ever clear, which is exactly what a user saw. It is recorded separately and the
      // next open retries.
      this.unavailable.set(input.canonicalPath, acquired.reason ?? "unavailable");
      this.conflicts.delete(input.canonicalPath);
      this.conflictOrigins.delete(input.canonicalPath);
      this.deps.debug?.(`hot unavailable reason=${acquired.reason ?? "unavailable"}`);
      return { outcome: "rejected", ...(acquired.reason ? { reason: acquired.reason } : {}), binding: acquired.binding, remote: acquired.remote };
    }
    if (acquired.outcome === "conflict") {
      this.unavailable.delete(input.canonicalPath);
      this.conflicts.set(input.canonicalPath, "conflict");
      // Which kind of "no" this was decides how a resolution has to work later: a refusal because the
      // document already holds a different revision is settled by making the two sides agree, while a room
      // that reported a conflict has to be re-pointed by the server. Recording it here is what keeps the
      // resolution from applying the wrong remedy — which is the loop a real device hit.
      this.conflictOrigins.set(input.canonicalPath, acquired.reason === "local-remote-mismatch" ? "mismatch" : "room");
      return { outcome: "conflict", ...(acquired.reason ? { reason: acquired.reason } : {}), binding: acquired.binding, remote: acquired.remote };
    }
    /**
     * Acquiring a room is asynchronous, while Obsidian can switch the pane and reuse its Editor object.
     * The caller owns that UI identity and gets the last word immediately before this binding becomes
     * capable of writing. A superseded acquire is abandoned without ever attaching its observer.
     */
    if (input.isCurrent && !input.isCurrent()) {
      session.abandon();
      this.hotPaths.delete(input.canonicalPath);
      this.handoffPaths.delete(input.canonicalPath);
      this.conflicts.delete(input.canonicalPath);
      this.conflictOrigins.delete(input.canonicalPath);
      await this.deps.store.deleteSession(input.canonicalPath).catch(() => undefined);
      return { outcome: "rejected", reason: "superseded", binding: acquired.binding, remote: acquired.remote };
    }
    this.unavailable.delete(input.canonicalPath);
    // Registered *before* the seed, because the seed is an edit that has to travel through the session.
    this.bindings.set(input.canonicalPath, binding);
    this.sessions.set(input.canonicalPath, session);
    try {
      binding.attach();
      /**
       * The caller's text becomes the first revision **only if the document is genuinely empty**, and that
       * can only be decided after the room's own state has arrived.
       *
       * The state comes over the socket, not with the acquire response, so "the document is empty right now"
       * usually just means "the welcome has not been applied yet". Seeding inside that window inserts a
       * second copy of text the room already holds — and Yjs, correctly, keeps both. This is not a rare race:
       * a path whose content is already in R2 gets a room **seeded from R2**, so every such open added one
       * more copy. A real test note ended up as eleven copies of the same line in R2, and an earlier version
       * of this bug doubled a diary. Waiting costs a few hundred milliseconds on the happy path and removes
       * the whole class.
       */
      if (!input.adoptRemote) {
        /**
         * Waiting is only necessary when the room *may* already hold content: a path whose revision is in R2
         * gets a room seeded from it, and a joined room holds one by definition. When R2 has nothing for the
         * path, the document cannot have content, so the seed is decided immediately — which keeps an offline
         * or slow socket from delaying every open.
         */
        const mayHoldContent = acquired.outcome === "joined" || acquired.remote?.exists === true;
        if (!mayHoldContent || await this.waitForSessionReady(session, 2_000)) await binding.seedFromTextIfEmpty(input.localText);
      }
    } catch (error) {
      if (session.status === "conflict") {
        // A failed outbox write already froze the session and retained the volatile operation. Keep the
        // binding visible to the resolver; tearing it down here would drop the only remaining copy of
        // the encoded edit while the server still owns the path.
        this.conflicts.set(input.canonicalPath, "conflict");
        return { outcome: "conflict", reason: "outbox-unavailable", binding: acquired.binding, remote: acquired.remote };
      }
      // A half-open session is worse than none: the path would be fenced with nothing behind it.
      this.bindings.delete(input.canonicalPath);
      this.sessions.delete(input.canonicalPath);
      throw error;
    }
    if (binding.isFrozen()) {
      this.conflicts.set(input.canonicalPath, "conflict");
      return { outcome: "conflict", reason: "editor-document-divergence", binding: acquired.binding, remote: acquired.remote };
    }
    this.hotPaths.add(input.canonicalPath);
    this.conflicts.delete(input.canonicalPath);
    return {
      outcome: "hot",
      session,
      binding: acquired.binding,
      ...(acquired.identity ? { identity: acquired.identity } : {}),
      remote: acquired.remote,
    };
  }

  /** Feeds one editor change into the session, if this path is hot. */
  async handleEditorChange(canonicalPath: string): Promise<void> {
    const binding = this.bindings.get(canonicalPath);
    if (!binding) return;
    await binding.handleEditorChange();
  }

  /**
   * Closes a document: flush, checkpoint, verify, release.
   *
   * On a completed handoff the cold baseline is committed immediately, because that is the moment the
   * cold path becomes allowed to touch the file again. On anything else the fence stays up.
   */
  async close(input: { canonicalPath: string; localText: string; checkpoint?: boolean }): Promise<HotCloseOutcome> {
    if (this.hasPendingRename(input.canonicalPath)) return { outcome: "handoff-pending", detail: "rename-unconfirmed" };
    const session = this.sessions.get(input.canonicalPath);
    if (!session) return { outcome: "not-hot" };
    const outcome = await session.close({
      checkpoint: input.checkpoint ?? true,
      localText: input.localText,
      operationId: this.nextOperationId("release"),
    });
    if (outcome.outcome === "handed-off" || outcome.outcome === "saved-hot-elsewhere") {
      // Either way this device's work is saved and its baseline is valid; the difference is whether the
      // *path* is free. When another client still holds the document, the fence stays up here: a cold
      // cycle on this device would otherwise race a session it cannot see.
      const binding = this.bindings.get(input.canonicalPath);
      binding?.detach();
      this.bindings.delete(input.canonicalPath);
      this.sessions.delete(input.canonicalPath);
      if (outcome.receipt && this.deps.commitBaseline) {
        await this.deps.commitBaseline(input.canonicalPath, session.baselineFrom(outcome.receipt));
      }
      if (outcome.outcome === "handed-off") {
        this.hotPaths.delete(input.canonicalPath);
        this.handoffPaths.delete(input.canonicalPath);
        this.conflicts.delete(input.canonicalPath);
      this.conflictOrigins.delete(input.canonicalPath);
      } else {
        // Saved here, owned elsewhere: the durable session record now says `disconnected`, which fences
        // the path as hot rather than as a pending handoff — nothing is pending on this device.
        this.handoffPaths.delete(input.canonicalPath);
        this.hotPaths.add(input.canonicalPath);
      }
      return outcome;
    }
    if (outcome.outcome === "handoff-pending") {
      this.hotPaths.delete(input.canonicalPath);
      this.handoffPaths.add(input.canonicalPath);
    }
    return outcome;
  }

  /** Re-acquires a path whose handoff never completed, e.g. after a restart. */
  async resumeHandoff(canonicalPath: string, editor: Editor, localText: string): Promise<HotOpenOutcome> {
    const handoffs = await this.deps.store.loadHandoffs();
    const handoff = handoffs.find(candidate => candidate.canonicalPath === canonicalPath);
    if (!handoff) {
      this.handoffPaths.delete(canonicalPath);
      return this.open({ canonicalPath, editor, localText });
    }
    const outcome = await this.open({ canonicalPath, editor, localText });
    if (outcome.outcome !== "hot" || !outcome.session) return outcome;
    const receipt = await outcome.session.requestCheckpoint(handoff.requiredRevision);
    if (receipt && receipt.contentHash === handoff.contentHash) {
      await this.deps.store.deleteHandoff(canonicalPath);
      this.handoffPaths.delete(canonicalPath);
      if (this.deps.commitBaseline) await this.deps.commitBaseline(canonicalPath, outcome.session.baselineFrom(receipt));
    }
    return outcome;
  }

  /**
   * Records that a hot file was changed on disk by something other than the editor the session is
   * bound to.
   *
   * This is the conservative first version of the design's external-modification rule: the external
   * bytes are not merged into the document (that is a later diff import), and they are emphatically not
   * ignored either. Marking the path conflicted keeps the cold path fenced and puts the fact in front of
   * the user, which is the difference between "we noticed" and "we silently overwrote your file".
   *
   * Returns `true` when this call was the one that raised the conflict, so a caller can notify once.
   */
  flagExternalEdit(canonicalPath: string): boolean {
    if (this.conflicts.has(canonicalPath)) return false;
    this.conflicts.set(canonicalPath, "external-local-edit");
    this.deps.onConflict?.(canonicalPath, "external-local-edit");
    return true;
  }

  /**
   * Stops owning a path on purpose, without a handoff.
   *
   * This is what "accept remote" means: the user has decided that whatever R2 holds is the truth, so
   * this device stops being an authority for the path. The session is torn down and both durable hot
   * records are removed, which releases the fence — and the cold path then reconciles the local file
   * against R2 with its ordinary rules. If the two still disagree, that is a *cold* conflict, and the
   * existing resolver can handle it, which is strictly better than leaving the file frozen forever.
   *
   * Nothing is deleted here: the local file stays exactly where it is.
   */
  private async abandon(canonicalPath: string): Promise<void> {
    const binding = this.bindings.get(canonicalPath);
    binding?.detach();
    this.bindings.delete(canonicalPath);
    const session = this.sessions.get(canonicalPath);
    this.sessions.delete(canonicalPath);
    session?.abandon();
    this.hotPaths.delete(canonicalPath);
    this.handoffPaths.delete(canonicalPath);
    this.conflicts.delete(canonicalPath);
    this.conflictOrigins.delete(canonicalPath);
    await this.deps.store.deleteSession(canonicalPath).catch(() => undefined);
    await this.deps.store.deleteHandoff(canonicalPath).catch(() => undefined);
    this.deps.onStatus?.(canonicalPath, "idle", "abandoned");
  }

  /**
   * Applies the local half of a resolution: which version of an externally edited file survives.
   *
   * `keep-local` here means the *disk* version, because that is the one the user is looking at and the
   * one this device did not write. Putting it into the editor is what makes it an ordinary local edit:
   * the binding diffs the buffer against the document and pushes one operation, so the external bytes
   * become part of the document rather than a special case the server has to learn about.
   *
   * Returns `false` when there is no editor to rewrite, which leaves the conflict in place.
   */
  private async resolveExternalEdit(canonicalPath: string, decision: "keep-local" | "accept-remote"): Promise<boolean> {
    const binding = this.bindingFor(canonicalPath);
    if (!binding) return false;
    const target = decision === "keep-local" ? await this.deps.readLocalText?.(canonicalPath) : binding.text();
    if (target === undefined) return false;
    await binding.applyTextAsLocalEdit(target);
    if (decision === "accept-remote") await this.deps.writeLocalText?.(canonicalPath, target);
    this.deps.onStatus?.(canonicalPath, "hot", "resolved");
    return true;
  }

  private clearConflict(canonicalPath: string): void {
    this.conflicts.delete(canonicalPath);
  }

  /**
   * Puts a hand-made result into the room, which is the only writer for a live path.
   *
   * The merged text comes from the person, not from R2 and not from the disk, so unlike `keep-local` it
   * cannot be read back out of the Vault — it has to be carried in. It is applied through
   * `applyTextAsLocalEdit`, which is the same path a keystroke takes: the binding diffs the merged text
   * against the document, records one operation, and forwards it. Seeding the document instead would be
   * the one thing this file must never do, because a seed that skips `onLocalUpdate` never reaches R2.
   *
   * **The stale session is abandoned first, and that is the whole point.** `open()` prefers
   * `session.resume()` whenever a record exists, and the record behind a conflict is exactly the session
   * the authority already refused — so joining without clearing it re-asks the same question and is told
   * "no" for the same reason. `accept-remote` is the forward that tells the server to retire that room;
   * after it, the join is a genuinely fresh incarnation, and the merged text goes into the new document
   * rather than into the one that was frozen.
   *
   * Returns `false` when there is no room to accept it; the caller leaves the conflict frozen, because a
   * decision that could not be delivered must not drop the fence.
   */
  async mergeThroughHot(canonicalPath: string, mergedText: string, editor?: Editor): Promise<boolean> {
    const carrier = editor ?? this.bindings.get(canonicalPath)?.editorInstance() ?? asEditor(new HeadlessEditor(mergedText));
    // Retire the room the authority refused. Without this the re-join resumes it and is refused again.
    if (this.conflicts.has(canonicalPath)) {
      const forwarded = await this.forwardServerResolve(canonicalPath, "accept-remote");
      if (!forwarded) {
        this.deps.debug?.("hot merge: the server still owns a room it will not re-point; the conflict stays");
        return false;
      }
    }
    // Joining with an empty local text is deliberate: the merged result is pushed afterwards, as a local
    // edit, so it becomes a document revision the room forwards. Passing it here would only seed.
    if (!(await this.joinAndDecide(canonicalPath, "accept-remote", "", carrier))) return false;
    const binding = this.bindingFor(canonicalPath);
    const session = this.sessionFor(canonicalPath);
    if (binding) {
      // The binding owns both halves: it diffs the merged text into the document and puts it in the pane.
      await binding.applyTextAsLocalEdit(mergedText);
      // The file is written too. A result that lives in R2 and in the editor but leaves disk holding one
      // of the losing sides makes the next cold cycle see a divergence the user never created.
      if (this.deps.writeLocalText) await this.deps.writeLocalText(canonicalPath, mergedText);
    } else if (this.deps.writeLocalText) {
      // No pane and no binding: the file is the only place the result can land, and the room was joined
      // with an empty local text, so nothing else carries it.
      await this.deps.writeLocalText(canonicalPath, mergedText);
    }
    const revision = session?.session?.lastAcceptedRevision;
    if (session && revision !== undefined) void session.requestCheckpoint(revision + 1).catch(() => undefined);
    return true;
  }

  /**
   * The conflicts a human has to decide about, in the order they should be shown.
   *
   * A conflict is a *frozen path*: cold sync is fenced, and nothing moves until someone chooses. A
   * pending handoff belongs on this list for the same reason — it fences a path, it may belong to a file
   * whose pane is long gone, and without an entry here there is no way for the user to resolve it. The
   * two are kept distinct because the honest advice differs: a handoff needs "did my content actually
   * get saved", a conflict needs "which version wins".
   */
  /**
   * Makes a refused join converge: the file and the document end up holding the same bytes.
   *
   * The join is attempted with *no claim* about local content, which is what lets the server hand over a
   * document this device has not been read against. After that the decision is a content decision:
   *
   * - `keep-local` pushes the file's bytes into the document, so the server's next checkpoint writes what
   *   the user can see. (The old behaviour asked the server to re-point its precondition instead, which
   *   wrote *the document's* version over R2 — the opposite of what the button said, and it also left the
   *   file and the room disagreeing, so the next open was refused for the same reason.)
   * - `accept-remote` writes the document's bytes into the file, so the pane and the disk show the version
   *   the server holds.
   *
   * Either way the next open joins cleanly, because the two sides now agree.
   */
  private async convergeMismatch(canonicalPath: string, decision: "keep-local" | "accept-remote", editor?: Editor): Promise<boolean> {
    const diskText = (await this.deps.readLocalText?.(canonicalPath)) ?? "";
    const carrier = editor ?? this.bindings.get(canonicalPath)?.editorInstance() ?? asEditor(new HeadlessEditor(diskText));
    if (await this.joinAndDecide(canonicalPath, decision, diskText, carrier)) return true;

    /**
     * The join can be refused for a reason content cannot fix: a **conflicted room** refuses every acquire
     * until the authority re-points it. A real device hit exactly this — the acquire answered 409 and no
     * decision could ever clear it, because the remedy (`/hot/resolve`) was never sent.
     *
     * So: re-point the room first, then make the two sides agree. The order matters — a join before the
     * re-point is refused again, and a re-point without the join publishes whichever version the room
     * happened to hold.
     */
    const forwarded = await this.forwardServerResolve(canonicalPath, decision);
    if (!forwarded) return false;
    // Retirement only changes authority. Rejoin the R2-backed incarnation to apply the chosen bytes.
    return await this.joinAndDecide(canonicalPath, decision, diskText, carrier);
  }

  /** One attempt at convergence: join without claiming local content, then apply the decision to it. */
  private async joinAndDecide(canonicalPath: string, decision: "keep-local" | "accept-remote", diskText: string, carrier: Editor, allowEmpty = false): Promise<boolean> {
    const joined = await this.open({ canonicalPath, editor: carrier, localText: diskText, adoptRemote: true });
    if (joined.outcome !== "hot") {
      this.deps.debug?.(`hot resolution: the join was refused (${joined.outcome}${joined.reason ? "/" + joined.reason : ""})`);
      return false;
    }
    const binding = this.bindingFor(canonicalPath);
    const session = this.sessionFor(canonicalPath);
    if (!binding || !session) return false;
    // The room's state arrives on the socket, not with the acquire response. Reading the document before it
    // has been applied would mean reading an empty one — and then writing *that* over the file.
    if (!(await this.waitForSessionReady(session))) {
      this.deps.debug?.("hot resolution: the session never became ready; the conflict stays");
      return false;
    }

    if (decision === "accept-remote") {
      // The welcome put the document's text into the carrier; the file on disk is what still disagrees, so
      // it is written directly rather than through an editor that may not be on screen.
      const remoteText = binding.text();
      // Never empty a file that has content: an empty document means the two sides still disagree, and that
      // call belongs to the user with the sizes in front of them, not to a write-back.
      if (!allowEmpty && remoteText.length === 0 && diskText.length > 0) {
        this.deps.debug?.("hot resolution: refusing to write an empty document over a non-empty file");
        return false;
      }
      if (this.deps.writeLocalText && remoteText !== diskText) await this.deps.writeLocalText(canonicalPath, remoteText);
      binding.replaceEditorText(remoteText);
      return true;
    }

    // Keep local: the file is authoritative. Put it in the pane, let the ordinary local-edit path push it
    // as one operation, then *ask* for a checkpoint without waiting for its receipt — the room saves on its
    // own schedule anyway, and a resolution that blocked on a frame would hang the window.
    await binding.applyTextAsLocalEdit(diskText);
    const record = session.session;
    if (record) void session.requestCheckpoint(record.lastAcceptedRevision + 1).catch(() => undefined);
    return true;
  }

  /**
   * Asks the authority to re-point a conflicted document, so a join can succeed again.
   *
   * `keep-local` only re-points the precondition and marks the room unsaved; the *content* decision still
   * belongs to the caller, which pushes the file's bytes after this returns. `accept-remote` is complete in
   * itself: ownership is dropped and the cold path reconciles the file against R2.
   *
   * Returns `false` when the server could not be told, which leaves the conflict exactly where it was.
   */
  private async forwardServerResolve(canonicalPath: string, decision: "keep-local" | "accept-remote"): Promise<boolean> {
    const record = this.sessions.get(canonicalPath)?.session;
    let identity: { documentId: string; epoch: number } | undefined = record ? { documentId: record.documentId, epoch: record.epoch } : undefined;
    if (!identity) {
      const status = await this.deps.client.pathStatus(canonicalPath).catch(() => undefined);
      if (status?.binding?.documentId) identity = { documentId: status.binding.documentId, epoch: status.binding.epoch };
    }
    if (!identity) {
      this.deps.debug?.("hot resolution: there is no document to re-point");
      return false;
    }
    try {
      const result = await this.deps.client.resolveConflict({
        operationId: this.nextOperationId("resolve"),
        canonicalPath,
        documentId: identity.documentId,
        epoch: identity.epoch,
        decision,
      });
      if (result.outcome === "not-found") {
        this.deps.debug?.("hot resolution: the server did not recognise the document");
        return false;
      }
      if (result.outcome === "abandoned") {
        await this.abandon(canonicalPath);
        return true;
      }
      return true;
    } catch (error) {
      this.deps.debug?.(`hot resolution: the server call failed (${error instanceof Error ? error.message : "unknown"})`);
      return false;
    }
  }

  /** Waits until the room's state has actually arrived, so nothing reads a document that is still empty. */
  private async waitForSessionReady(session: HotDocumentSession, timeoutMs = 8_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = session.session?.status;
      if (status === "hot") return true;
      if (status === "conflict" || status === "closed") return false;
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  /**
   * Drops every local hot record for a path whose file no longer exists.
   *
   * Deleting a file on disk must also end its session, its pending handoff and any conflict about it — a
   * conflict for a path with no file is a question with no answer, and leaving it in the list is how the
   * user ends up staring at a decision that can never succeed.
   */
  async forget(canonicalPath: string): Promise<void> {
    await this.abandon(canonicalPath);
    this.unavailable.delete(canonicalPath);
    this.conflictOrigins.delete(canonicalPath);
  }

  /** Paths whose hot session could not start because the server did not serve them, with the reason. */
  hotUnavailable(): Array<{ canonicalPath: string; detail: string }> {
    return [...this.unavailable.entries()].map(([canonicalPath, detail]) => ({ canonicalPath, detail })).sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath));
  }

  hotConflicts(): Array<{ canonicalPath: string; reason: HotConflictReason }> {
    const merged = new Map<string, HotConflictReason>();
    for (const canonicalPath of this.handoffPaths) merged.set(canonicalPath, "handoff-pending");
    // A real conflict outranks the handoff record: it is the newer, more specific fact about the path.
    for (const [canonicalPath, reason] of this.conflicts) merged.set(canonicalPath, reason);
    return [...merged.entries()]
      .map(([canonicalPath, reason]) => ({ canonicalPath, reason }))
      .sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath));
  }

  /**
   * Applies a human decision to a frozen conflict.
   *
   * Three kinds of conflict end here, and they need different machinery:
   *
   * - **`external-local-edit`** never left this device: something wrote the file underneath the editor.
   *   `keep-local` takes the *disk* bytes as the document, `accept-remote` puts the room's content back on
   *   disk. Neither needs the server, because the server never disagreed with either version.
   * - **a mismatch** (`local-remote-mismatch`): the document already holds a revision this device has not
   *   read, so the acquire was refused. The remedy is to make the two sides *agree*: join without claiming
   *   any local content, then either push the file's bytes (keep-local) or write the room's bytes to the
   *   file (accept-remote). Merely dropping the fence — which is what this used to do — means the next open
   *   is refused for exactly the same reason, and the user sees a conflict every single time.
   * - **a room conflict** (an external writer, or R2 under a deletion) is the server's to resolve, so the
   *   decision is forwarded: `keep-local` re-points the room's precondition at what R2 holds now, and
   *   `accept-remote` gives up ownership and lets cold sync reconcile the file.
   *
   * **`merged`** is the fourth answer, and it is the one that must *write*, so it takes the local half of
   * `keep-local` (the room is re-pointed) and carries its own text instead of reading the disk. Two things
   * make it necessary rather than convenient: a fence cannot be dropped by a decision that never lands
   * (below), and the merged text exists nowhere the room can read it — not in R2, which holds one losing
   * side, and not on disk, which holds the other. Handing it to the cold executor instead is what froze
   * `未命名.md`: the cold side holds the version-bound intent, but the live room fences it, and the fence
   * only comes down when the *room* has accepted the result. So the decision goes through the room, which
   * is the path's only writer, and the cold intent is retired by `clearResolution` once it lands.
   *
   * A failed resolution leaves the conflict exactly where it was. Losing the fence because a decision
   * could not be delivered would be the one outcome worse than a frozen file.
   */
  async resolveConflict(
    canonicalPath: string,
    decision: "keep-local" | "accept-remote" | "merged",
    editor?: Editor,
    mergedText?: string,
  ): Promise<{ outcome: "resolved" | "abandoned" | "pending-confirmation" | "failed"; detail?: string }> {
    // A pending handoff is on the same list but not in the same map: it is a different fact about the
    // path, and it is resolved differently (see below).
    const pendingHandoff = this.handoffPaths.has(canonicalPath);
    const reason = this.conflicts.get(canonicalPath) ?? (pendingHandoff ? "handoff-pending" : undefined);
    if (!reason) return { outcome: "failed", detail: "no-conflict" };

    // The result is this device's own text, so it takes the local-edit path rather than the remote one:
    // the room has to forward it, which is also what makes it durable in R2.
    if (decision === "merged") {
      if (mergedText === undefined) return { outcome: "failed", detail: "missing-merged-text" };
      try {
        if (reason === "external-local-edit") {
          // The document here is already this device's version; only the file and the pane still disagree.
          const binding = this.bindings.get(canonicalPath);
          if (!binding) return { outcome: "failed", detail: "no-editor" };
          await binding.applyTextAsLocalEdit(mergedText);
          if (this.deps.writeLocalText) await this.deps.writeLocalText(canonicalPath, mergedText);
        } else if (!(await this.mergeThroughHot(canonicalPath, mergedText, editor))) {
          // Never a dropped fence: the conflict stays listed so the decision can be delivered later.
          return { outcome: "failed", detail: "join-refused" };
        }
        this.clearConflict(canonicalPath);
        this.deps.onResolved?.(canonicalPath, "merged");
        return { outcome: "resolved" };
      } catch (error) {
        return { outcome: "failed", detail: error instanceof Error ? error.message : "unknown" };
      }
    }

    if (reason === "external-local-edit") {
      try {
        const resolved = await this.resolveExternalEdit(canonicalPath, decision);
        if (resolved) this.clearConflict(canonicalPath);
        return resolved ? { outcome: "resolved" } : { outcome: "failed", detail: "no-editor" };
      } catch (error) {
        return { outcome: "failed", detail: error instanceof Error ? error.message : "unknown" };
      }
    }

    // The mismatch case is settled locally, by content, and never by asking the server to re-point a room
    // whose document is not the version the user chose.
    if (this.conflictOrigins.get(canonicalPath) === "mismatch" && this.conflicts.has(canonicalPath)) {
      try {
        const converged = await this.convergeMismatch(canonicalPath, decision, editor);
        if (converged) {
          this.clearConflict(canonicalPath);
          this.deps.onResolved?.(canonicalPath, decision);
          return { outcome: "resolved" };
        }
        this.conflicts.set(canonicalPath, "conflict");
        return { outcome: "failed", detail: "join-refused" };
      } catch (error) {
        this.conflicts.set(canonicalPath, "conflict");
        return { outcome: "failed", detail: error instanceof Error ? error.message : "unknown" };
      }
    }

    const session = this.sessions.get(canonicalPath);
    const record = session?.session;
    // A conflict can outlive its pane — a handoff that never completed, or a conflict restored at
    // startup — so the identity comes from the live session when there is one and from the binding
    // otherwise. Without an identity there is nothing on the server to decide about; releasing the local
    // fence is then the whole answer.
    let identity: { documentId: string; epoch: number } | undefined = record ? { documentId: record.documentId, epoch: record.epoch } : undefined;
    if (!identity) {
      const status = await this.deps.client.pathStatus(canonicalPath).catch(() => undefined);
      const binding = status?.binding;
      // A tombstoned binding can name a retired document, and there is nothing to resolve for one.
      if (binding?.documentId) identity = { documentId: binding.documentId, epoch: binding.epoch };
    }
    if (!identity) {
      this.clearConflict(canonicalPath);
      await this.deps.store.deleteSession(canonicalPath).catch(() => undefined);
      this.deps.onResolved?.(canonicalPath, decision);
      return { outcome: "abandoned" };
    }
    try {
      let result = await this.deps.client.resolveConflict({
        operationId: this.nextOperationId("resolve"),
        canonicalPath,
        documentId: identity.documentId,
        epoch: identity.epoch,
        decision,
      });
      // A restored session can name an incarnation already replaced on the server. Accepting R2
      // must retire the current losing room, rather than only dropping this device's stale record.
      if (result.outcome === "not-found" && decision === "accept-remote") {
        const current = (await this.deps.client.pathStatus(canonicalPath)).binding;
        if (current?.documentId && current.state !== "deleted" && (current.documentId !== identity.documentId || current.epoch !== identity.epoch)) {
          result = await this.deps.client.resolveConflict({ operationId: this.nextOperationId("resolve-current"), canonicalPath, documentId: current.documentId, epoch: current.epoch, decision });
        }
      }
      /**
       * The server has no document for this path any more — it was deleted, or its incarnation was retired.
       *
       * A conflict cannot outlive the thing it is about. Reporting a failure here left the user with a
       * decision that could never be delivered, on a file that no longer exists: resolving it always ended
       * in `not-found`, and the path stayed frozen. The local record is dropped and the path is handed back.
       */
      if (result.outcome === "not-found") {
        await this.abandon(canonicalPath);
        this.deps.onResolved?.(canonicalPath, decision);
        return { outcome: "abandoned", detail: "not-found" };
      }
      if (result.outcome === "abandoned") {
        await this.abandon(canonicalPath);
        const diskText = await this.deps.readLocalText?.(canonicalPath);
        if (diskText === undefined) {
          this.conflicts.set(canonicalPath, "conflict");
          this.conflictOrigins.set(canonicalPath, "mismatch");
          return { outcome: "failed", detail: "local-unreadable" };
        }
        const carrier = editor ?? asEditor(new HeadlessEditor(diskText));
        const adopted = await this.joinAndDecide(canonicalPath, "accept-remote", diskText, carrier);
        if (!adopted) {
          this.conflicts.set(canonicalPath, "conflict");
          this.conflictOrigins.set(canonicalPath, "mismatch");
          return { outcome: "failed", detail: "join-refused" };
        }
        this.clearConflict(canonicalPath);
        this.deps.onResolved?.(canonicalPath, decision);
        return { outcome: "resolved" };
      }
      // Keep local: the room now owns a document it considers unsaved, so its next checkpoint writes
      // this device's content over the revision that lost. When the pane is still open, ask for that
      // checkpoint now; when it is not, the room's own alarm does it — a server-side object does not
      // need a client to finish what the user decided.
      this.clearConflict(canonicalPath);
      if (pendingHandoff) {
        // A handoff is *unverified*, not conflicted: the point of it was to prove this device's content
        // reached R2, and asking the room to save does not prove it did. The fence stays until the
        // ordinary verification succeeds, and the caller is told so rather than shown a success.
        if (record) await session?.requestCheckpoint(record.lastAcceptedRevision + 1).catch(() => undefined);
        this.deps.onResolved?.(canonicalPath, decision);
        return { outcome: "pending-confirmation" };
      }
      // Whether the room was re-pointed or a handoff was confirmed, "keep local" is only honest once this
      // device's bytes are *in* the document. Without that the room's next checkpoint publishes whatever the
      // document happened to hold — the opposite of the button the user pressed, and how a stale room's
      // duplicated content reached R2 again after a resolution.
      if (decision === "keep-local" && !pendingHandoff) {
        const diskText = (await this.deps.readLocalText?.(canonicalPath)) ?? "";
        const carrier = editor ?? this.bindings.get(canonicalPath)?.editorInstance() ?? asEditor(new HeadlessEditor(diskText));
        const pushed = await this.joinAndDecide(canonicalPath, "keep-local", diskText, carrier);
        if (!pushed) this.deps.debug?.("hot resolution: the document was re-pointed but this device's bytes were not pushed");
      }
      if (record) await session?.requestCheckpoint(record.lastAcceptedRevision + 1).catch(() => undefined);
      this.deps.onResolved?.(canonicalPath, decision);
      return { outcome: "resolved" };
    } catch (error) {
      this.conflicts.set(canonicalPath, "conflict");
      return { outcome: "failed", detail: error instanceof Error ? error.message : "unknown" };
    }
  }

  /**
   * Points a live session at the pane's current editor.
   *
   * Called whenever a file becomes active again: the pane may hold a *different* editor instance than the
   * one the session was opened against, and a session that observes the wrong instance is silent — owned on
   * the server, invisible to the user.
   */
  rebind(canonicalPath: string, editor: Editor, mode: "fill" | "adopt" = "fill"): boolean {
    const binding = this.bindings.get(canonicalPath);
    if (!binding) return false;
    if (binding.editorInstance() === editor) return false;
    binding.rebind(editor, mode);
    this.deps.debug?.(`hot session re-bound to the pane's editor (${mode})`);
    return true;
  }

  /** The namespace lifecycle, as the plugin asks for it. All three are the server's decision. */
  async create(canonicalPath: string, localText: string): Promise<NamespaceResult> {
    return this.deps.client.namespace({
      type: "create",
      operationId: this.nextOperationId("create"),
      clientId: this.deps.clientId,
      canonicalPath,
      expectedPathState: { state: "absent" },
      local: { contentHash: await hotContentHash(localText), size: localText.length },
    });
  }

  async delete(canonicalPath: string): Promise<NamespaceResult> {
    const session = this.sessions.get(canonicalPath);
    const record = session?.session;
    if (!session || !record) {
      return {
        protocol: 1,
        operationId: this.nextOperationId("delete"),
        type: "delete",
        outcome: "conflict",
        reason: "unknown-document",
        phase: "failed",
        canonicalPath,
        binding: null,
      };
    }
    const receipt = session.checkpointReceipt;
    const result = await this.deps.client.namespace({
      type: "delete",
      operationId: this.nextOperationId("delete"),
      clientId: this.deps.clientId,
      canonicalPath,
      documentId: record.documentId,
      expectedEpoch: record.epoch,
      expectedRemoteETag: receipt?.r2ETag ?? null,
      expectedDocumentRevision: receipt?.documentRevision ?? null,
    });
    // Only the authority's applied verdict permits local ownership records to disappear. A rejected
    // delete remains fenced: the local file is gone, but the room may still own content and its alarm
    // may still be completing the namespace transition.
    if (result.outcome === "applied") await this.forget(canonicalPath);
    return result;
  }

  async rename(canonicalPath: string, toPath: string): Promise<NamespaceResult> {
    const session = this.sessions.get(canonicalPath);
    const record = session?.session;
    if (!session || !record) {
      return {
        protocol: 1,
        operationId: this.nextOperationId("rename"),
        type: "rename",
        outcome: "conflict",
        reason: "unknown-document",
        phase: "failed",
        canonicalPath: toPath,
        fromPath: canonicalPath,
        binding: null,
      };
    }
    const waiting = [...this.pendingRenames.values()].find(item => item.intent.documentId === record.documentId);
    if (waiting) {
      if (toPath !== waiting.intent.toPath) {
        if (waiting.nextPath && waiting.nextPath !== toPath) {
          this.reservedRenamePaths.delete(waiting.nextPath);
          this.sessions.delete(waiting.nextPath);
          this.bindings.delete(waiting.nextPath);
        }
        waiting.nextPath = toPath;
        this.reservedRenamePaths.add(toPath);
        this.sessions.set(toPath, session);
        const binding = this.bindings.get(canonicalPath);
        if (binding) this.bindings.set(toPath, binding);
        await session.rememberRename(waiting.intent, toPath);
      }
      return this.pendingRenameResult(waiting.intent);
    }
    const operationId = this.nextOperationId("rename");
    const finishTransition = session.beginNamespaceTransition();
    try {
      // No old-epoch operation may still be in flight when the room quiesces. New typing waits at the
      // session barrier and will be persisted with whichever epoch this operation leaves active.
      const intent: Extract<NamespaceIntent, { type: "rename" }> = {
        protocol: 1,
        type: "rename",
        operationId,
        clientId: this.deps.clientId,
        fromPath: canonicalPath,
        toPath,
        documentId: record.documentId,
        expectedEpoch: record.epoch,
        expectedFromBinding: { documentId: record.documentId, epoch: record.epoch },
        expectedToPathState: { state: "absent" },
      };
      await session.rememberRename(intent);
      this.pendingRenames.set(operationId, { intent, finish: finishTransition });
      // Keep the renamed editor attached while its new path is fenced from the cold executor.
      this.sessions.set(toPath, session);
      const binding = this.bindings.get(canonicalPath);
      if (binding) this.bindings.set(toPath, binding);
      return await this.confirmPendingRename(intent);
    } finally {
      if (!this.pendingRenames.has(operationId)) {
        this.reservedRenamePaths.delete(toPath);
        finishTransition();
      }
    }
  }

  hasPendingRename(path: string): boolean {
    return this.reservedRenamePaths.has(path) || [...this.pendingRenames.values()].some(({ intent }) => intent.fromPath === path || intent.toPath === path);
  }

  /** Fence the target at the Vault event, before the serialized transition queue can yield. */
  reserveLocalRename(fromPath: string, toPath: string): void {
    const session = this.sessions.get(fromPath);
    if (!session) return;
    this.reservedRenamePaths.add(toPath);
  }

  private pendingRenameResult(intent: Extract<NamespaceIntent, { type: "rename" }>): NamespaceResult {
    return { protocol: 1, operationId: intent.operationId, type: "rename", outcome: "pending", phase: "requested", reason: "unavailable", canonicalPath: intent.toPath, fromPath: intent.fromPath, binding: null };
  }

  private scheduleRenameRecovery(): void {
    if (this.stopped || this.renameRetryTimer || !this.pendingRenames.size) return;
    this.renameRetryTimer = setTimeout(() => {
      this.renameRetryTimer = undefined;
      if (this.renameRetryRunning || this.stopped) return;
      this.renameRetryRunning = true;
      void (async () => {
        for (const { intent } of [...this.pendingRenames.values()]) {
          if (this.stopped) break;
          await this.confirmPendingRename(intent);
        }
      })().catch(error => this.deps.debug?.(`hot rename recovery failed: ${String(error)}`)).finally(() => {
        this.renameRetryRunning = false;
        this.scheduleRenameRecovery();
      });
    }, 3000);
  }

  private async confirmPendingRename(intent: Extract<NamespaceIntent, { type: "rename" }>): Promise<NamespaceResult> {
    const live = this.sessions.get(intent.fromPath) ?? this.sessions.get(intent.toPath);
    if (live && !(await live.drain())) {
      this.scheduleRenameRecovery();
      return this.pendingRenameResult(intent);
    }
    let result: NamespaceResult;
    try { result = await this.deps.client.namespace(intent); }
    catch {
      this.deps.debug?.("hot rename result unconfirmed; both paths remain fenced");
      this.scheduleRenameRecovery();
      return this.pendingRenameResult(intent);
    }
    if (this.stopped) return this.pendingRenameResult(intent);
    const applied = (result.outcome === "applied" || result.outcome === "duplicate") && result.identity;
    if (!applied && result.phase !== "failed") {
      this.scheduleRenameRecovery();
      return this.pendingRenameResult(intent);
    }
    const pending = this.pendingRenames.get(intent.operationId);
    const session = this.sessions.get(intent.fromPath) ?? this.sessions.get(intent.toPath);
    if (session) {
      await session.rememberRename(undefined);
      if (applied) await session.adoptRename(intent.toPath, result.identity!.epoch);
      else {
        this.sessions.delete(intent.toPath);
        this.bindings.delete(intent.toPath);
      }
    } else {
      const record = (await this.deps.store.loadSessions()).find(row => row.pendingRename?.operationId === intent.operationId);
      if (record) {
        const next = { ...record, ...(applied ? { canonicalPath: intent.toPath, epoch: result.identity!.epoch } : {}) };
        delete next.pendingRename;
        delete next.nextRenamePath;
        await this.deps.store.putSession(next);
        if (applied) { await this.deps.store.deleteSession(intent.fromPath); this.hotPaths.delete(intent.fromPath); this.hotPaths.add(intent.toPath); }
      }
    }
    this.pendingRenames.delete(intent.operationId);
    this.reservedRenamePaths.delete(intent.toPath);
    pending?.finish?.();
    if (applied && !session) await this.deps.onRenamed?.(intent.fromPath, intent.toPath);
    if (applied && pending?.nextPath && pending.nextPath !== intent.toPath) {
      if (session) await this.rename(intent.toPath, pending.nextPath);
      else {
        const nextIntent = { ...intent, operationId: this.nextOperationId("rename"), fromPath: intent.toPath, toPath: pending.nextPath, expectedEpoch: result.identity!.epoch, expectedFromBinding: { documentId: intent.documentId, epoch: result.identity!.epoch } };
        const record = (await this.deps.store.loadSessions()).find(row => row.canonicalPath === intent.toPath);
        if (record) await this.deps.store.putSession({ ...record, pendingRename: nextIntent });
        this.pendingRenames.set(nextIntent.operationId, { intent: nextIntent });
        this.scheduleRenameRecovery();
      }
    }
    return applied ? { ...result, outcome: "applied" } : result;
  }

  /**
   * Gives up the room that is blocking a cold write, when the room has nothing left to publish.
   *
   * The fence has two halves and this is the second one. Letting a resolved merge past the *local* fence is
   * not enough: the cold write still asks the Gateway for a lease, and the Gateway refuses while a room is
   * bound to the path — it has no way to know the room on this device is a husk. The plugin is the only one
   * that can tell it, and `accept-remote` is exactly that message: retire this binding and let the cold path
   * reconcile the file.
   *
   * Narrow on purpose, and it mirrors `isFencedFor`:
   *
   * - `external-local-edit` is never released. That session is live, the room still holds this device's
   *   version, and retiring it would throw away the side the user is looking at.
   * - An operational session is never released: it can publish, so the cold writer must not race it.
   * - `handoff-pending` is never released here; its content is unproven and it has its own screen.
   *
   * Returns whether ownership was actually given up, so a caller can tell "nothing to release" from
   * "released" without guessing.
   */
  async releaseRefusedRoom(canonicalPath: string): Promise<boolean> {
    if (this.conflicts.get(canonicalPath) !== "conflict") return false;
    const status = this.sessions.get(canonicalPath)?.session?.status;
    if (status !== undefined && sessionStatusIsOperational(status)) return false;
    if (this.handoffPaths.has(canonicalPath)) return false;
    // A cold draft does not include an unseen, uncheckpointed room revision. Automatic merges may
    // only retire it when its complete text is already protected by the local file.
    const remote = await this.deps.client.pathStatus(canonicalPath);
    if (!remote.room || remote.room.clients > 0) return false;
    if (remote.room.pendingSave) {
      const local = await this.deps.readLocalText?.(canonicalPath);
      if (local === undefined || await hotContentHash(local) !== remote.room.currentContentHash) return false;
    }
    const forwarded = await this.forwardServerResolve(canonicalPath, "accept-remote");
    this.deps.debug?.(`hot release refused room outcome=${forwarded ? "released" : "refused"}`);
    return forwarded;
  }

  resolutionSnapshot(path: string): Promise<HotResolutionSnapshot | null> {
    return this.deps.client.resolutionSnapshot(path);
  }

  async retryUnifiedResolution(path: string, snapshot: HotResolutionSnapshot, content: string, operationId: string): Promise<HotMergedResolutionResult> {
    const result = await this.deps.client.applyMergedResolution({ protocol: 1, operationId, canonicalPath: path,
      documentId: snapshot.documentId, epoch: snapshot.epoch, decision: "merged", confirmOnly: true, expectedRevision: snapshot.revision,
      expectedContentHash: snapshot.contentHash, expectedRemoteETag: snapshot.remoteETag, content });
    return result;
  }

  async applyUnifiedResolution(path: string, snapshot: HotResolutionSnapshot, content: string, operationId: string,
    expectedLocalHash: string, expectedEditorHash?: string, editor?: Editor, accepted = false): Promise<HotMergedResolutionResult> {
    if (!accepted && this.sessions.get(path) && !(await this.sessions.get(path)!.drain())) return { outcome: "stale" };
    const local = await this.deps.readLocalText?.(path);
    if (local === undefined || (!accepted && await hotContentHash(local) !== expectedLocalHash)) return { outcome: "stale" };
    if (!accepted && expectedEditorHash && (!editor || await hotContentHash(editor.getValue()) !== expectedEditorHash)) return { outcome: "stale" };
    const result = await this.deps.client.applyMergedResolution({ protocol: 1, operationId, canonicalPath: path,
      documentId: snapshot.documentId, epoch: snapshot.epoch, decision: "merged", expectedRevision: snapshot.revision,
      expectedContentHash: snapshot.contentHash, expectedRemoteETag: snapshot.remoteETag, content });
    if (result.outcome !== "saved" && result.outcome !== "pending") return result;
    const existing = this.sessions.get(path);
    if (existing?.session?.status === "hot" && this.bindings.get(path) && !this.bindings.get(path)!.isFrozen()) {
      const deadline = Date.now() + 8000;
      while (existing.observedServerRevision < (result.revision ?? 0) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      if (existing.observedServerRevision < (result.revision ?? 0) || this.bindings.get(path)!.isFrozen()) return { outcome: "pending", revision: result.revision };
      // The server operation travels through the existing CRDT bridge; subsequent typing is retained.
      const current = this.bindings.get(path)!.text();
      if (this.deps.writeLocalText) await this.deps.writeLocalText(path, current);
    } else {
      // A frozen/headless client rejoins the same incarnation after the accepted resolution.
      if (expectedEditorHash && editor && await hotContentHash(editor.getValue()) !== expectedEditorHash) return { outcome: "pending", revision: result.revision };
      await this.abandon(path);
      const carrier = editor ?? asEditor(new HeadlessEditor(content));
      if (!(await this.joinAndDecide(path, "accept-remote", local, carrier, true))) return { outcome: "pending", revision: result.revision };
    }
    if (result.outcome === "saved") this.clearConflict(path);
    return result;
  }

  /** Discovers a frozen server room without acquiring a session or changing either version. */
  async discoverRemoteConflict(canonicalPath: string): Promise<void> {
    if (this.conflicts.has(canonicalPath) || this.handoffPaths.has(canonicalPath) || this.sessions.has(canonicalPath)) return;
    const status = await this.deps.client.pathStatus(canonicalPath).catch(() => undefined);
    const room = status?.room;
    const binding = status?.binding;
    if (room?.state === "conflicted" && binding?.documentId) {
      await this.deps.store.putSession({ canonicalPath, documentId: binding.documentId, epoch: binding.epoch,
        clientId: this.deps.clientId, status: "conflict", lastAcceptedRevision: room.latestAcceptedRevision,
        lastCheckpointedRevision: room.latestCheckpointedRevision, pendingSave: room.pendingSave,
        requestedRevision: null, updatedAt: this.deps.now ? this.deps.now() : Date.now() }).catch(() => undefined);
      this.conflicts.set(canonicalPath, "conflict");
      this.deps.onConflict?.(canonicalPath, "remote-room-conflict");
      this.deps.debug?.(`hot discovered remote conflict path-digest=${pathDigest(canonicalPath)} accepted=${room.latestAcceptedRevision} checkpointed=${room.latestCheckpointedRevision}`);
    }
  }

  /** The cold-mutation authority a cold write must hold while hot sessions exist. */
  async acquireColdAuthority(canonicalPath: string, expectedRemoteETag: string | null, operation: "put" | "delete" = "put"): Promise<{ granted: boolean; token?: string; operationId?: string; reason?: string }> {
    const operationId = this.nextOperationId("cold");
    const result = await this.deps.client.coldAcquire({
      operationId,
      operation,
      canonicalPath,
      clientId: this.deps.clientId,
      expectedRemoteETag,
    });
    return result.outcome === "granted" ? { granted: true, operationId, ...(result.token ? { token: result.token } : {}) } : { granted: false, ...(result.reason ? { reason: result.reason } : {}) };
  }

  /**
   * The lease lifecycle the cold executor drives: ask before the mutation, report after it.
   *
   * The token stays here rather than travelling with the caller, so there is exactly one place that
   * knows which leases this device still holds — and exactly one place that can leak one.
   */
  async authorizeColdMutation(canonicalPath: string, expectedRemoteETag: string | null = null, operation?: string): Promise<"granted" | "deferred" | "unreachable"> {
    if (this.isFencedFor(canonicalPath, operation ?? "")) return "deferred";
    // Downloading an R2 checkpoint is a local read consumer, not another remote writer.
    // The executor guards the GET by ETag and the local write by its observed version.
    // Another device's live editor must not block delivery of its saved checkpoints here.
    if (operation === "download" || operation === "resolve-accept-remote" || operation === "resolve-accept-remote-delete" || operation === "delete-local") return "granted";
    try {
      const mutation = operation === "delete-remote" || operation === "resolve-accept-local-delete" ? "delete" : "put";
      const acquired = await this.acquireColdAuthority(canonicalPath, expectedRemoteETag, mutation);
      if (!acquired.granted || !acquired.token) {
        this.deps.debug?.(`hot cold authority path-digest=${pathDigest(canonicalPath)} denied=${acquired.reason ?? "missing-token"}`);
        if (acquired.reason === "hot-owned" && !this.conflicts.has(canonicalPath)) {
          await this.discoverRemoteConflict(canonicalPath);
        }
        return "deferred";
      }
      this.coldLeases.set(canonicalPath, { token: acquired.token, operationId: acquired.operationId!, operation: mutation });
      return "granted";
    } catch {
      // Unreachable is not denied: it is the documented degradation, and R2's own preconditions plus the
      // room's conditional checkpoint are what catch a write the control plane never heard about.
      return "unreachable";
    }
  }

  async settleColdMutation(canonicalPath: string): Promise<void> {
    const lease = this.coldLeases.get(canonicalPath);
    if (!lease) return;
    this.coldLeases.delete(canonicalPath);
    await this.deps.client.coldCommit({
      token: lease.token,
      operationId: lease.operationId,
      clientId: this.deps.clientId,
      operation: lease.operation,
      canonicalPath,
      etag: null,
      size: null,
      committedAt: this.deps.now ? this.deps.now() : Date.now(),
    }).catch(() => undefined);
  }

  async commitColdAuthority(input: { token: string; canonicalPath: string; etag: string | null; size: number | null }): Promise<{ outcome: string; hotOwned: boolean }> {
    return this.deps.client.coldCommit({
      token: input.token,
      operationId: this.nextOperationId("cold-commit"),
      clientId: this.deps.clientId,
      operation: "put",
      canonicalPath: input.canonicalPath,
      etag: input.etag,
      size: input.size,
      committedAt: this.deps.now ? this.deps.now() : Date.now(),
    });
  }

  async pathStatus(canonicalPath: string): Promise<HotPathStatus> {
    return this.deps.client.pathStatus(canonicalPath);
  }

  /** Statuses for the UI, without exposing paths in a way the diagnostics rule forbids. */
  summary(): { hot: number; handoffPending: number; conflicts: number; deferred: { paths: number; operations: number } } {
    return {
      hot: this.hotPaths.size,
      handoffPending: this.handoffPaths.size,
      conflicts: this.conflicts.size,
      deferred: this.deferredSummary(),
    };
  }

  /** Diagnostics for one path: statuses only, never content. */
  statusOf(canonicalPath: string): { status: HotSessionStatus; reason?: string } {
    const session = this.sessions.get(canonicalPath);
    return {
      status: session?.status ?? (this.handoffPaths.has(canonicalPath) ? "handoff-pending" : "idle"),
      ...(this.conflicts.has(canonicalPath) ? { reason: this.conflicts.get(canonicalPath)! } : {}),
    };
  }

  /** The intent the plugin would send, exposed so a caller can log it without rebuilding it. */
  intentFor(path: string, type: NamespaceIntent["type"]): string {
    return `${type}:${path}`;
  }
}



