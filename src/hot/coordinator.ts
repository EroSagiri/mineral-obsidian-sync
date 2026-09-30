import type { Editor } from "obsidian";
import { hotContentHash, type HotAcquireResult, type HotRemoteObservation, type PathBinding } from "@mineral/sync-core/hot-protocol";
import type { NamespaceIntent, NamespaceResult } from "@mineral/sync-core/namespace-protocol";
import type { HotGatewayClient } from "./client";
import { HotEditorBinding } from "./editor-binding";
import { HeadlessEditor, asEditor } from "./headless-editor";
import type { HotStateStore } from "./store";
import { HotDocumentSession, type HotCloseOutcome } from "./session";
import { sessionStatusFencesCold, type HotBaseline, type HotSessionRecord, type HotSessionStatus } from "./types";
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
  /** A human decision landed; the caller asks the cold path to look at the path again. */
  onResolved?(canonicalPath: string, decision: "keep-local" | "accept-remote"): void;
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
  private readonly coldLeases = new Map<string, string>();

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
      if (record.status === "closed") {
        await this.deps.store.deleteSession(record.canonicalPath);
        continue;
      }
      if (record.status === "conflict") this.conflicts.set(record.canonicalPath, "conflict");
      if (record.status === "handoff-pending") this.handoffPaths.add(record.canonicalPath);
      else this.hotPaths.add(record.canonicalPath);
    }
    for (const handoff of handoffs) this.handoffPaths.add(handoff.canonicalPath);
    this.deps.debug?.(`hot restore: sessions=${sessions.length} handoffs=${handoffs.length}`);
    return { sessions, handoffs: handoffs.length };
  }

  /* --------------------------------------------------------------------------------------------
   * The cold fence
   * ------------------------------------------------------------------------------------------ */

  fenceReason(canonicalPath: string): HotFenceReason | null {
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

  fencedPaths(): string[] {
    return [...new Set([...this.hotPaths, ...this.handoffPaths, ...this.conflicts.keys()])];
  }

  plannerFact(canonicalPath: string): "deferred-by-hot-ownership" | null {
    return this.isFenced(canonicalPath) ? "deferred-by-hot-ownership" : null;
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

  /**
   * Opens a document for hot editing.
   *
   * The caller has already produced the binding and applied nothing: acquisition comes first, because
   * a local file whose content is not a version the room knows must *not* be merged in. That decision
   * belongs to the server, and `conflict` is its answer.
   */
  async open(input: { canonicalPath: string; editor: Editor; localText: string; adoptRemote?: boolean; isCurrent?: () => boolean }): Promise<HotOpenOutcome> {
    const existing = this.sessions.get(input.canonicalPath);
    if (existing) return { outcome: "hot", session: existing };

    // `adoptRemote` claims nothing about local content: the server then hands over the document instead of
    // refusing a join it cannot verify, which is the first half of every mismatch resolution.
    const local = input.adoptRemote ? null : { contentHash: await hotContentHash(input.localText), size: input.localText.length };
    const binding = new HotEditorBinding({
      editor: input.editor,
      ...(this.deps.preserveViewport ? { preserveViewport: () => this.deps.preserveViewport!(input.canonicalPath) } : {}),
      // The session is registered before anything can edit through the binding (see below), so this
      // lookup is what delivers the seed. It used to be registered *after* the seed, which quietly threw
      // the first content of every brand-new hot note away: the binding inserted it into the document,
      // found no session to send it to, and the note reached R2 only if somebody later happened to type.
      onLocalUpdate: (update, operationId) => {
        const session = this.sessions.get(input.canonicalPath);
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
        this.conflicts.set(input.canonicalPath, "conflict");
        this.conflictOrigins.set(input.canonicalPath, "mismatch");
        this.hotPaths.delete(input.canonicalPath);
        this.handoffPaths.add(input.canonicalPath);
        this.deps.debug?.(`hot freeze path-digest=${pathDigest(input.canonicalPath)} reason=${reason}`);
        this.deps.onConflict?.(input.canonicalPath, "editor-document-divergence");
        // Tear down the live session: no more reconnects, no more incoming `operation` frames that
        // would otherwise keep advancing the Y.Doc past the diagnostic scene the resolver needs.
        const session = this.sessions.get(input.canonicalPath);
        if (session) {
          void session.freeze(`editor-document-divergence: ${reason}`).catch(error => {
            this.deps.debug?.(`hot freeze persist failed: ${error instanceof Error ? error.message : "unknown"}`);
          });
        }
      },
      debug: this.deps.debug,
    });
    const session = new HotDocumentSession({
      client: this.deps.client,
      store: this.deps.store,
      doc: binding,
      clientId: this.deps.clientId,
      canonicalPath: input.canonicalPath,
      events: {
        onStatus: (status, detail) => {
          if (status === "hot") this.hotPaths.add(input.canonicalPath);
          if (status === "handoff-pending") {
            this.handoffPaths.add(input.canonicalPath);
            this.hotPaths.delete(input.canonicalPath);
          }
          // The nuanced reason stays in the session record (`statusOf().reason`); the map only classifies
          // it for the fence and for the resolution UI, which treats every server-side cause the same way.
          if (status === "conflict") this.conflicts.set(input.canonicalPath, "conflict");
          this.deps.onStatus?.(input.canonicalPath, status, detail);
        },
        onConflict: reason => {
          // Every cause the server reports is, for this device's purposes, the same kind of fact: the
          // authority refused the write and the path needs a human. The exact reason is preserved in the
          // session record, which is what `statusOf` and the resolver's message read.
          this.conflicts.set(input.canonicalPath, "conflict");
          this.deps.onConflict?.(input.canonicalPath, reason);
        },
        onDeleted: () => {
          this.hotPaths.delete(input.canonicalPath);
          this.bindings.delete(input.canonicalPath);
          this.sessions.delete(input.canonicalPath);
        },
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
    this.deps.onStatus?.(canonicalPath, "hot", "resolved");
    return true;
  }

  private clearConflict(canonicalPath: string): void {
    this.conflicts.delete(canonicalPath);
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
    // `accept-remote` is complete here: this device has given the path up and the cold path reconciles the
    // file against R2 with its ordinary rules (including asking, if both sides moved).
    if (decision === "accept-remote") return true;
    return await this.joinAndDecide(canonicalPath, decision, diskText, carrier);
  }

  /** One attempt at convergence: join without claiming local content, then apply the decision to it. */
  private async joinAndDecide(canonicalPath: string, decision: "keep-local" | "accept-remote", diskText: string, carrier: Editor): Promise<boolean> {
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
      if (remoteText.length === 0 && diskText.length > 0) {
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
   * A failed resolution leaves the conflict exactly where it was. Losing the fence because a decision
   * could not be delivered would be the one outcome worse than a frozen file.
   */
  async resolveConflict(canonicalPath: string, decision: "keep-local" | "accept-remote", editor?: Editor): Promise<{ outcome: "resolved" | "abandoned" | "pending-confirmation" | "failed"; detail?: string }> {
    // A pending handoff is on the same list but not in the same map: it is a different fact about the
    // path, and it is resolved differently (see below).
    const pendingHandoff = this.handoffPaths.has(canonicalPath);
    const reason = this.conflicts.get(canonicalPath) ?? (pendingHandoff ? "handoff-pending" : undefined);
    if (!reason) return { outcome: "failed", detail: "no-conflict" };

    if (reason === "external-local-edit") {
      const resolved = await this.resolveExternalEdit(canonicalPath, decision);
      if (resolved) this.clearConflict(canonicalPath);
      return resolved ? { outcome: "resolved" } : { outcome: "failed", detail: "no-editor" };
    }

    // The mismatch case is settled locally, by content, and never by asking the server to re-point a room
    // whose document is not the version the user chose.
    if (this.conflictOrigins.get(canonicalPath) === "mismatch" && this.conflicts.has(canonicalPath)) {
      const converged = await this.convergeMismatch(canonicalPath, decision, editor);
      if (converged) {
        this.clearConflict(canonicalPath);
        this.deps.onResolved?.(canonicalPath, decision);
        return { outcome: "resolved" };
      }
      return { outcome: "failed", detail: "join-refused" };
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
      const result = await this.deps.client.resolveConflict({
        operationId: this.nextOperationId("resolve"),
        canonicalPath,
        documentId: identity.documentId,
        epoch: identity.epoch,
        decision,
      });
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
        this.deps.onResolved?.(canonicalPath, decision);
        return { outcome: "abandoned" };
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
    const result = await this.deps.client.namespace({
      type: "rename",
      operationId: this.nextOperationId("rename"),
      clientId: this.deps.clientId,
      fromPath: canonicalPath,
      toPath,
      documentId: record.documentId,
      expectedEpoch: record.epoch,
      expectedFromBinding: { documentId: record.documentId, epoch: record.epoch },
      expectedToPathState: { state: "absent" },
    });
    if (result.outcome === "applied") {
      // The document is the same one and the session keeps running: only the path binding moved, and
      // the session learns the new epoch from the room's own `document-state` frame.
      const binding = this.bindings.get(canonicalPath);
      if (binding) {
        this.bindings.delete(canonicalPath);
        this.bindings.set(toPath, binding);
      }
      const moved = this.sessions.get(canonicalPath);
      if (moved) {
        this.sessions.delete(canonicalPath);
        this.sessions.set(toPath, moved);
      }
      this.hotPaths.delete(canonicalPath);
      this.hotPaths.add(toPath);
    }
    return result;
  }

  /** The cold-mutation authority a cold write must hold while hot sessions exist. */
  async acquireColdAuthority(canonicalPath: string, expectedRemoteETag: string | null): Promise<{ granted: boolean; token?: string; reason?: string }> {
    const result = await this.deps.client.coldAcquire({
      operationId: this.nextOperationId("cold"),
      operation: "put",
      canonicalPath,
      clientId: this.deps.clientId,
      expectedRemoteETag,
    });
    return result.outcome === "granted" ? { granted: true, ...(result.token ? { token: result.token } : {}) } : { granted: false, ...(result.reason ? { reason: result.reason } : {}) };
  }

  /**
   * The lease lifecycle the cold executor drives: ask before the mutation, report after it.
   *
   * The token stays here rather than travelling with the caller, so there is exactly one place that
   * knows which leases this device still holds — and exactly one place that can leak one.
   */
  async authorizeColdMutation(canonicalPath: string, expectedRemoteETag: string | null = null): Promise<"granted" | "deferred" | "unreachable"> {
    if (this.isFenced(canonicalPath)) return "deferred";
    try {
      const acquired = await this.acquireColdAuthority(canonicalPath, expectedRemoteETag);
      if (!acquired.granted || !acquired.token) return "deferred";
      this.coldLeases.set(canonicalPath, acquired.token);
      return "granted";
    } catch {
      // Unreachable is not denied: it is the documented degradation, and R2's own preconditions plus the
      // room's conditional checkpoint are what catch a write the control plane never heard about.
      return "unreachable";
    }
  }

  async settleColdMutation(canonicalPath: string): Promise<void> {
    const token = this.coldLeases.get(canonicalPath);
    if (!token) return;
    this.coldLeases.delete(canonicalPath);
    await this.deps.client.coldCommit({
      token,
      operationId: this.nextOperationId("cold-commit"),
      clientId: this.deps.clientId,
      operation: "put",
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

  async pathStatus(canonicalPath: string): Promise<{ binding: PathBinding | null; remote: HotRemoteObservation | null; hotOwned: boolean }> {
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








