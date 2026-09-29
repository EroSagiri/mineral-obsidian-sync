import * as Y from "yjs";
import type { Editor, EditorPosition } from "obsidian";
import { decodeHotPayload, encodeHotPayload } from "@mineral/sync-core/hot-protocol";
import type { HotDocumentPort } from "./session";

/**
 * The Yjs ↔ Obsidian editor bridge (Phase Hot-E).
 *
 * The rules this bridge has to defend, and the order of the comments is the order of trust:
 *
 * 1. **Remote writes are *one atomic replacement*, never a translated delta.** A Yjs delta is a list of
 *    `retain / insert / delete` parts that describe the document's old text. Translating them one-to-one
 *    into editor changes looks correct in isolation but is wrong as soon as the same source offset is
 *    both an insert target and a delete range — i.e. `[{insert: "m"}, {delete: 4}]`, the "replace the
 *    first four characters with m" pattern. Two editor changes that touch the same range either apply
 *    against a stale buffer (the editor library is not required to be atomic across them) or wipe each
 *    other out. A live diary accumulated 5400+ revisions of exactly this failure: every remote update
 *    put the wrong character at offset 0, the editor-change handler read the buffer back as a "user
 *    edit", and the loop kept re-feeding itself. The corrected bridge never translates the delta; it
 *    computes `singleChange(editorText, docText)` after the Yjs update is integrated and writes *one*
 *    regular editor transaction.
 *
 * 2. **The editor and the Y.Doc must agree after every write.** A write that lands with the editor and
 *    the document still disagreeing means this bridge no longer owns the buffer's relationship with the
 *    room. Continuing to translate further updates would extend the divergence forever, and reading the
 *    buffer back as user input would be a lie. The bridge freezes: no more remote writes are applied,
 *    no more local operations are generated, the conflict machinery is told the path is unrecoverable
 *    and the user gets an honest "your file and the room disagree" instead of a silent loop.
 *
 * 3. **Echo suppression is a content marker, not a time window.** The bridge records the text it last
 *    wrote; an editor-change event whose new value equals that text is the bridge reading its own write.
 *    Comparing content survives event-queue reordering and, unlike a time window, cannot swallow a real
 *    keystroke.
 */

/** Marks a transaction this bridge produced, so its own observer can ignore it. */
export const HOT_EDITOR_ORIGIN = "mineral-hot";
/** Marks an update that came *from* the server, which this bridge must write into the editor. */
export const HOT_REMOTE_ORIGIN = "mineral-hot-remote";
/**
 * Marks the application of a full CRDT state (a `welcome`).
 *
 * The observer must skip this: a welcome lands on an empty Y.Doc and the delta it produces is the
 * entire document text. Letting it run `applyDeltaToEditor` would re-insert text the editor already
 * shows — which was the *previous* "string-loop" bug before this rewrite. The editor is brought into
 * agreement by the explicit reconcile in `applyEncoded`, not by the observer.
 */
export const HOT_WELCOME_ORIGIN = "mineral-hot-welcome";

/**
 * The smallest single replacement that turns `before` into `after`.
 *
 * A one-character insertion produces a one-character insert, which is what keeps the editor's own undo
 * history legible; a whole-document replace would make every remote keystroke look like a rewrite.
 * Crucially, this function finds the smallest *contiguous* difference between two strings: it cannot
 * express two distinct changes, but a single remote update's effect on the document can always be
 * rendered as a single contiguous change after the common prefix and common suffix are stripped.
 */
export function singleChange(before: string, after: string): { index: number; remove: number; insert: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore--;
    endAfter--;
  }
  // Never split a surrogate pair: half a code point in the CRDT is a corrupted document.
  if (start > 0 && start < before.length && start < after.length) {
    const high = before.charCodeAt(start - 1);
    const low = after.charCodeAt(start);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) start--;
  }
  return { index: start, remove: endBefore - start, insert: after.slice(start, endAfter) };
}

export interface HotEditorDependencies {
  editor: Editor;
  /** Called for every local edit, with the encoded update and a fresh operation id. */
  onLocalUpdate(update: string, clientOperationId: string): void | Promise<void>;
  nextOperationId?: () => string;
  debug?(message: string): void;
  /**
   * Called immediately before any write to the editor; returns a function to run right after it.
   *
   * Writing to a buffer moves the viewport — CodeMirror keeps the cursor visible, and a change above
   * the cursor scrolls the pane — so a sync that lands while somebody is reading moves their view.
   * The caller captures the scroll position here and puts it back afterwards. Optional, because an
   * editor with no pane (a resolution for a file that is not open) has no viewport to preserve.
   */
  preserveViewport?(): (() => void) | undefined;
  /**
   * Fires when a remote write left the editor and the Y.Doc disagreeing. The bridge is frozen at
   * that point and will no longer translate updates or generate local operations; the coordinator
   * must turn this into a conflict the user can act on.
   */
  onFreeze?(reason: string): void;
}

export class HotEditorBinding implements HotDocumentPort {
  readonly doc = new Y.Doc();
  private readonly body: Y.Text;
  private observer: ((event: Y.YTextEvent, transaction: Y.Transaction) => void) | null = null;
  private attached = false;
  private operationCounter = 0;
  /** Set while this bridge is writing to the editor, so the editor's own change event is ignored. */
  private applying = false;
  /**
   * Set when a remote write left the editor and the document unable to agree. After this point, no
   * remote translation runs and no local operation is emitted. The session has to surface it as a
   * conflict and stop pretending the buffer is in sync with the room.
   */
  private frozen = false;
  private freezeReason: string | null = null;
  /**
   * The text this bridge last wrote into the editor.
   *
   * It is the second, content-based half of echo suppression: Obsidian may deliver an `editor-change`
   * after this call has already returned, so a flag alone would let the bridge read its own write
   * back as a local edit. Comparing the *content* works no matter when the event arrives, and unlike
   * a time window it cannot swallow a real keystroke.
   */
  private writtenEditorText: string | null = null;

  constructor(private readonly deps: HotEditorDependencies) {
    this.body = this.doc.getText("markdown");
  }

  /** The document's content, which is what the room's CRDT must converge with. */
  text(): string {
    return this.body.toString();
  }

  value(): string {
    return this.deps.editor.getValue();
  }

  /**
   * Whether the bridge has frozen because a remote write could not converge the editor with the
   * document. After this returns true, no further updates will be applied and no local operations
   * will be generated; the caller is expected to treat the path as a real conflict.
   */
  isFrozen(): boolean {
    return this.frozen;
  }

  /** The reason the bridge froze, for diagnostics and the resolver's notice. */
  freezeDetail(): string | null {
    return this.freezeReason;
  }

  /**
   * Replaces the buffer with a version the user chose.
   *
   * This is the only method that writes to the editor without a corresponding document change, and
   * it exists for exactly two decisions: take the bytes that were written underneath us, or put the
   * document's own content back on top of them. The caller follows it with the ordinary
   * editor-change path, so whichever version was chosen becomes an ordinary local edit rather than a
   * special case the server would have to understand.
   */
  replaceEditorText(text: string): void {
    const editor = this.deps.editor;
    if (editor.getValue() === text) return;
    /**
     * Rewriting the buffer wholesale is the one thing that moves the viewport, and a resolution — or
     * a fill — must not throw the reader to the top of a long note. The cursor is put back where it
     * was; CodeMirror keeps the viewport around the cursor, so this is what keeps scrolling usable
     * while a session is live.
     */
    const cursor = typeof editor.getCursor === "function" ? editor.getCursor() : null;
    this.aroundEditorWrite(() => {
      editor.setValue(text);
      if (cursor) {
        try { editor.setCursor(cursor); }
        catch { /* the old position may no longer exist in the new text */ }
      }
    });
  }

  /**
   * Makes the document hold the given text, whatever the buffer happened to show.
   *
   * A resolution is an act, not a diff: the user decided that these bytes are the truth. Diffing is
   * wrong here for a reason that cost several device rounds — the buffer may never have shown the
   * document at all (a stale pane, a replaced editor), so "the buffer did not change" says nothing
   * about whether the document should change. Diffing in that state produced *nothing*, and a "keep
   * this file's version" click left the room holding the version that lost.
   *
   * Returns whether an operation was sent.
   */
  async applyTextAsLocalEdit(text: string): Promise<boolean> {
    if (this.frozen) return false;
    const current = this.body.toString();
    this.replaceEditorText(text);
    if (current === text) {
      this.writtenEditorText = this.deps.editor.getValue();
      return false;
    }
    const change = singleChange(current, text);
    const update = await this.transact(() => {
      if (change.remove > 0) this.body.delete(change.index, change.remove);
      if (change.insert.length > 0) this.body.insert(change.index, change.insert);
    });
    this.writtenEditorText = this.deps.editor.getValue();
    if (update === null) return false;
    await this.deps.onLocalUpdate(update, this.nextOperationId());
    return true;
  }

  /**
   * Points the bridge at a different editor for the same document.
   *
   * Obsidian replaces the editor instance whenever a pane is rebuilt: restoring a workspace,
   * switching between reading and editing, moving a tab to another pane, or simply finishing a
   * layout restore after the plugin has already opened the session. A bridge that keeps observing
   * the *old* instance receives no keystrokes at all — the path stays owned by this device, nothing
   * is ever sent, and from the user's side it is indistinguishable from "sync is broken". A real
   * test found exactly that: the document was owned, R2 never changed, and no operation ever arrived.
   *
   * The new editor is filled from the document, because the document is the truth for a bound
   * session — and the buffer we wrote is recorded, so the fill is not mistaken for a user edit and
   * pushed back as one.
   */
  rebind(editor: Editor, mode: "fill" | "adopt" = "fill"): void {
    if (this.deps.editor === editor) return;
    this.detach();
    this.deps.editor = editor;
    const text = this.body.toString();
    if (mode === "fill") {
      /**
       * Only a pane with **nothing** in it is filled from the document.
       *
       * A pane that already holds text is either the file's own content or the user's typing, and
       * rewriting it is both destructive and the thing that jumps the viewport to the top — reported
       * as "scrolling is impossible while hot sync runs". When the buffer and the document disagree,
       * the ordinary diff (or the conflict machinery) decides; a silent overwrite does not.
       */
      if (editor.getValue().length === 0 && text.length > 0) {
        this.aroundEditorWrite(() => editor.setValue(text));
        this.writtenEditorText = editor.getValue();
      } else {
        // The buffer has content of its own: whatever it holds is what the next diff must consider.
        this.writtenEditorText = editor.getValue();
      }
    } else {
      /**
       * The user is typing *in this editor right now*, so the buffer is the truth — including when it
       * is **empty**, which is exactly what a select-all-and-delete looks like.
       *
       * An earlier version filled an empty buffer from the document here, "so the next diff cannot
       * delete the document's content". That turned a deliberate deletion into a fight: the buffer
       * was emptied, the document had not caught up for a moment, the fill put the text back, the
       * user deleted again — the note visibly jittered. The diff is the right mechanism; a
       * resurrection is not.
       */
      this.writtenEditorText = null;
    }
    this.attach();
  }

  /**
   * Runs an editor write with the viewport held in place.
   *
   * The restore runs *last*, after any cursor restoration, because keeping the cursor visible is
   * itself a scroll: without this order the pane jumps to the cursor even though the reader had
   * scrolled elsewhere.
   */
  private aroundEditorWrite(write: () => void): void {
    const restore = this.deps.preserveViewport?.();
    try { write(); }
    finally { restore?.(); }
  }

  attach(): void {
    if (this.attached) return;
    this.observer = (event, transaction) => {
      // The observer is the in-process CRDT-notification path for any local edit that already
      // happened to the document. Welcomes and bridge-produced edits never need to retranslate the
      // editor: the welcome is reconciled by `applyEncoded`, and the bridge's own transact writes
      // are mirrored to the editor by the same call. We only need to translate a remote write that
      // came in over the wire — and that is handled in `applyEncoded` too, not here. So the
      // observer never produces editor deltas in normal operation; it exists only because Yjs
      // requires a handler for `observe`. Keep it cheap: skip on the known origins.
      if (transaction.origin === HOT_EDITOR_ORIGIN || transaction.origin === HOT_WELCOME_ORIGIN || transaction.origin === HOT_REMOTE_ORIGIN) return;
    };
    this.body.observe(this.observer);
    this.attached = true;
  }

  detach(): void {
    if (this.observer) this.body.unobserve(this.observer);
    this.observer = null;
    this.attached = false;
  }

  /**
   * Pushes content into an empty document, and makes the editor agree with the result.
   *
   * A brand-new note has no remote content, so the file *is* the first revision. Two details come
   * from a real device:
   *
   * - the text is passed in rather than read from the editor, because a mobile pane can hand back an
   *   editor whose buffer is not loaded yet. Seeding "from the editor" then seeds nothing, and a
   *   note that was opened hot never reaches R2 at all until someone types into it;
   * - after seeding, an editor that is still empty is filled from the document. The insert is marked
   *   with this bridge's own origin, so the observer deliberately does not echo it back — which
   *   would leave the pane showing an empty file while the document holds its content.
   *
   * Seeding only when the document is empty is what keeps this from becoming "push my whole file
   * at everyone" on every join.
   */
  async seedFromTextIfEmpty(text: string): Promise<boolean> {
    if (this.frozen || this.body.length > 0 || text.length === 0) return false;
    const update = await this.transact(() => this.body.insert(0, text));
    if (this.deps.editor.getValue().length === 0 && this.body.length > 0) this.replaceEditorText(this.body.toString());
    // The seed is an edit like any other: it has to be *sent*. An earlier version only inserted it
    // into the document, which left a brand-new note with its content in the CRDT and nothing in
    // R2 — and then the next keystroke diffed against the seeded text and uploaded only the new
    // characters, so the first revision of a new file was missing its beginning.
    if (update === null) return false;
    await this.deps.onLocalUpdate(update, this.nextOperationId());
    return true;
  }

  /** The editor this bridge is bound to, for callers that have to place it somewhere else. */
  editorInstance(): Editor { return this.deps.editor; }

  /**
   * Applies a full CRDT state (a `welcome`) and reconciles the editor with what is now in the
   * document.
   *
   * The welcome is the *first* state the room sends, and a desktop pane that already shows the
   * file's body must not have that body re-inserted: an earlier version applied the welcome's
   * full-text insert delta on top of an editor that already displayed the same text, which is
   * exactly how the mobile rollout started duplicating user content on every desktop open. The
   * observer therefore skips this origin, and the editor is reconciled by `applyEncoded` only
   * when the two texts actually differ.
   */
  applyState(state: string): void {
    this.applyEncoded(state, "state");
  }

  /** Applies one remote update. */
  applyRemote(update: string): void {
    this.applyEncoded(update, "update");
  }

  /**
   * Decoding is a boundary, so a bad payload fails in the diagnostics and not as an unhandled
   * rejection.
   *
   * Something the CRDT cannot read is either a protocol mismatch or corruption. In both cases the
   * honest response is to keep the session alive and say so: a thrown error here surfaces as an
   * unhandled promise rejection inside a plugin, where nothing catches it.
   *
   * After the Yjs update is integrated, the editor is reconciled with the result via one atomic
   * single-replacement transaction. This is the single chokepoint through which both `state` and
   * `update` flow — and the only place where the editor is ever asked to change by the bridge.
   */
  private applyEncoded(payload: string, what: string): void {
    if (this.frozen) return;
    const bytes = decodeHotPayload(payload);
    if (!bytes) {
      this.deps.debug?.(`hot ${what} was not decodable`);
      return;
    }
    const origin = what === "state" ? HOT_WELCOME_ORIGIN : HOT_REMOTE_ORIGIN;
    try {
      Y.applyUpdate(this.doc, bytes, origin);
    } catch (error) {
      this.deps.debug?.(`hot ${what} could not be applied: ${error instanceof Error ? error.message : "unknown"}`);
      return;
    }
    this.reconcileEditorFromDocument(what);
  }

  /**
   * Brings the editor into agreement with `this.body` by writing the *smallest single replacement*
   * that turns the current editor text into the current document text.
   *
   * This is the only place in the bridge that translates a CRDT change into an editor change. The
   * previous implementation walked the Yjs delta part-by-part and emitted one editor change per
   * part; that translation is wrong for any delta whose parts target overlapping source ranges
   * (a "replacement" like `[{insert: "m"}, {delete: 4}]`) because the editor library is not
   * required to apply overlapping changes atomically, and the second change can land against the
   * buffer that the first change already mutated.
   *
   * Computing `singleChange(editorText, docText)` after the Yjs update is integrated sidesteps the
   * entire class: the document and the buffer reach the same string in one regular editor
   * transaction, regardless of how the delta was chunked. The "smallest single replacement" is a
   * regular editor range edit, so cursor movement, undo and selection behave locally as the
   * operand dictates.
   *
   * The post-condition is enforced: if the write does not bring the editor to the document's text,
   * the bridge freezes and emits `onFreeze`. A frozen bridge generates no further operations; the
   * caller is responsible for turning that into a conflict the user can act on.
   */
  private reconcileEditorFromDocument(source: string): void {
    if (this.frozen) return;
    const editorText = this.deps.editor.getValue();
    const docText = this.body.toString();
    if (editorText === docText) {
      this.writtenEditorText = editorText;
      return;
    }
    const change = singleChange(editorText, docText);
    this.applying = true;
    try {
      this.aroundEditorWrite(() => this.deps.editor.transaction({
        changes: [{
          from: this.positionAt(editorText, change.index),
          to: this.positionAt(editorText, change.index + change.remove),
          text: change.insert,
        }],
      }, HOT_EDITOR_ORIGIN));
      const afterWrite = this.deps.editor.getValue();
      this.writtenEditorText = afterWrite;
      if (afterWrite !== docText) {
        /**
         * The editor and the document cannot be reconciled by a regular transaction. Continuing to
         * apply further remote updates would extend the divergence forever, and reading the buffer
         * back as a user edit (the next `handleEditorChange` invocation) would push the wrong content
         * out to the room. This is exactly the silent permanent fork the live device hit. Freeze:
         * no more remote writes, no more local operations, the conflict machinery takes over from
         * here.
         */
        this.freeze(`hot freeze after ${source}: editor=${truncate(afterWrite)} doc=${truncate(docText)}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown";
      this.freeze(`hot editor transaction failed during ${source}: ${detail}`);
    } finally {
      this.applying = false;
    }
  }

  /**
   * Puts the bridge into the terminal "cannot reconcile" state. Records the reason, emits the
   * `onFreeze` event exactly once, and is idempotent — a second freeze (e.g. a freeze path that
   * fired inside a reconcile and another reconcile that races it) does not double-emit.
   */
  private freeze(reason: string): void {
    if (this.frozen) return;
    this.frozen = true;
    this.freezeReason = reason;
    this.deps.debug?.(reason);
    this.deps.onFreeze?.(reason);
  }

  /**
   * Reconciles the editor with the document after a local change event.
   *
   * The change event has already updated the editor, so this is a *read* of the new value, not a
   * mutation: it turns "the editor now says X" into the smallest CRDT edit that says the same
   * thing. The CRDT side is one transaction; the bridge then sends the operation to the room.
   *
   * A frozen bridge does not generate operations: there is no Y.Doc it can keep coherent with the
   * buffer, and pushing an operation would extend the divergence. The path is fenced by the
   * coordinator; the user will resolve it through the conflict UI.
   */
  async handleEditorChange(): Promise<void> {
    if (this.applying || this.frozen) return;
    const current = this.deps.editor.getValue();
    if (this.writtenEditorText !== null && current === this.writtenEditorText) {
      // Nothing has changed in *this* buffer since the bridge last looked at it: either our own
      // write being reported back, or an event for an editor that is not showing anything new.
      return;
    }
    this.writtenEditorText = current;
    const known = this.body.toString();
    if (current === known) return;
    const change = singleChange(known, current);
    const update = await this.transact(() => {
      if (change.remove > 0) this.body.delete(change.index, change.remove);
      if (change.insert.length > 0) this.body.insert(change.index, change.insert);
    });
    if (update === null) return;
    /**
     * After pushing our local edit, the document and the editor should match. If they do not, the
     * Y.Doc has reached a state that our buffer cannot express — the same terminal state as a remote
     * freeze. From here on, no more operations, no more writes; the path is fenced.
     */
    if (this.deps.editor.getValue() !== this.body.toString()) {
      this.freeze(`hot freeze after local edit: editor=${truncate(this.deps.editor.getValue())} doc=${truncate(this.body.toString())}`);
      return;
    }
    await this.deps.onLocalUpdate(update, this.nextOperationId());
  }

  private nextOperationId(): string {
    this.operationCounter += 1;
    return this.deps.nextOperationId ? this.deps.nextOperationId() : `${Date.now().toString(36)}-${this.operationCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Runs a CRDT edit and encodes the delta it produced. `null` when nothing changed. */
  private async transact(mutate: () => void): Promise<string | null> {
    const before = Y.encodeStateVector(this.doc);
    this.doc.transact(mutate, HOT_EDITOR_ORIGIN);
    const update = Y.encodeStateAsUpdate(this.doc, before);
    // An empty update means the edit was a no-op; sending it would burn a revision for nothing.
    return update.byteLength <= 2 ? null : encodeHotPayload(update);
  }

  private positionAt(text: string, index: number): EditorPosition {
    let line = 0;
    let lineStart = 0;
    const limit = Math.min(index, text.length);
    for (let position = 0; position < limit; position++) {
      if (text.charCodeAt(position) === 10) {
        line += 1;
        lineStart = position + 1;
      }
    }
    return { line, ch: limit - lineStart };
  }
}

/** Short, escaped form of a buffer for freeze diagnostics — full text does not fit in a notice. */
function truncate(value: string, limit = 80): string {
  const escaped = value.replace(/[\r\n]/g, "\\n");
  return escaped.length <= limit ? JSON.stringify(escaped) : `${JSON.stringify(escaped.slice(0, limit))}\u2026`;
}