import * as Y from "yjs";
import type { Editor, EditorPosition } from "obsidian";
import { decodeHotPayload, encodeHotPayload } from "@mineral/sync-core/hot-protocol";
import type { HotDocumentPort } from "./session";

/**
 * The Yjs ↔ Obsidian editor bridge (Phase Hot-E).
 *
 * Two properties decide whether this is usable or infuriating:
 *
 * - **Echo suppression is a source marker, not a time window.** An update this class applied itself is
 *   skipped because the transaction carries a known origin; a "ignore modify events for the next
 *   500 ms" rule would eventually swallow a real keystroke, and it would do it silently.
 * - **Remote edits arrive as one editor transaction with precise ranges.** Replacing the whole document
 *   would work on the wire and destroy the cursor, the selection, and the undo history on every remote
 *   keystroke.
 *
 * The bridge owns the `Y.Doc` because the document is the thing that survives the editor: a pane can be
 * closed and reopened, and the CRDT must not be rebuilt from Markdown every time.
 */

/** Marks a transaction this bridge produced, so its own observer can ignore it. */
export const HOT_EDITOR_ORIGIN = "mineral-hot";
/** Marks an update that came *from* the server, which this bridge must write into the editor. */
export const HOT_REMOTE_ORIGIN = "mineral-hot-remote";
/**
 * Marks the application of a full CRDT state (a `welcome`).
 *
 * The observer must skip this: a welcome lands on an empty Y.Doc and the delta it produces is the entire
 * document text. Letting it run `applyDeltaToEditor` would re-insert text the editor already shows and is
 * exactly how the desktop "string-loop" duplicate-content bug appeared after the mobile rollout. The
 * editor is reconciled explicitly by `applyState`, not by the observer.
 */
export const HOT_WELCOME_ORIGIN = "mineral-hot-welcome";

type Delta = Array<{ retain?: number; insert?: string | Uint8Array; delete?: number }>;

function textOf(item: string | Uint8Array | undefined): string {
  if (typeof item === "string") return item;
  if (item instanceof Uint8Array) return new TextDecoder().decode(item);
  return "";
}

/**
 * The smallest single replacement that turns `before` into `after`.
 *
 * A one-character insertion produces a one-character insert, which is what keeps the editor's own undo
 * history legible; a whole-document replace would make every remote keystroke look like a rewrite.
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
   * Writing to a buffer moves the viewport — CodeMirror keeps the cursor visible, and a change above the
   * cursor scrolls the pane — so a sync that lands while somebody is reading moves their view. The caller
   * captures the scroll position here and puts it back afterwards. Optional, because an editor with no pane
   * (a resolution for a file that is not open) has no viewport to preserve.
   */
  preserveViewport?(): (() => void) | undefined;
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
   * The text this bridge last wrote into the editor.
   *
   * It is the second, content-based half of echo suppression: Obsidian may deliver an ditor-change`r
   * after this call has already returned, so a flag alone would let the bridge read its own write back
   * as a local edit. Comparing the *content* works no matter when the event arrives, and unlike a time
   * window it cannot swallow a real keystroke.
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
   * Replaces the buffer with a version the user chose.
   *
   * This is the only method that writes to the editor without a corresponding document change, and it
   * exists for exactly two decisions: take the bytes that were written underneath us, or put the
   * document's own content back on top of them. The caller follows it with the ordinary editor-change
   * path, so whichever version was chosen becomes an ordinary local edit rather than a special case the
   * server would have to understand.
   */
  replaceEditorText(text: string): void {
    const editor = this.deps.editor;
    if (editor.getValue() === text) return;
    /**
     * Rewriting the buffer wholesale is the one thing that moves the viewport, and a resolution — or a fill —
     * must not throw the reader to the top of a long note. The cursor is put back where it was; CodeMirror
     * keeps the viewport around the cursor, so this is what keeps scrolling usable while a session is live.
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
   * A resolution is an act, not a diff: the user decided that these bytes are the truth. Diffing is wrong
   * here for a reason that cost several device rounds — the buffer may never have shown the document at all
   * (a stale pane, a replaced editor), so "the buffer did not change" says nothing about whether the document
   * should change. Diffing in that state produced *nothing*, and a "keep this file's version" click left the
   * room holding the version that lost.
   *
   * Returns whether an operation was sent.
   */
  async applyTextAsLocalEdit(text: string): Promise<boolean> {
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
   * Obsidian replaces the editor instance whenever a pane is rebuilt: restoring a workspace, switching
   * between reading and editing, moving a tab to another pane, or simply finishing a layout restore after
   * the plugin has already opened the session. A bridge that keeps observing the *old* instance receives no
   * keystrokes at all — the path stays owned by this device, nothing is ever sent, and from the user's side
   * it is indistinguishable from "sync is broken". A real test found exactly that: the document was owned,
   * R2 never changed, and no operation ever arrived.
   *
   * The new editor is filled from the document, because the document is the truth for a bound session — and
   * The buffer we wrote is recorded, so the fill is not mistaken for a user edit and pushed back as one.
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
       * A pane that already holds text is either the file's own content or the user's typing, and rewriting
       * it is both destructive and the thing that jumps the viewport to the top — reported as "scrolling is
       * impossible while hot sync runs". When the buffer and the document disagree, the ordinary diff (or the
       * conflict machinery) decides; a silent overwrite does not.
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
       * The user is typing *in this editor right now*, so the buffer is the truth — including when it is
       * **empty**, which is exactly what a select-all-and-delete looks like.
       *
       * An earlier version filled an empty buffer from the document here, "so the next diff cannot delete
       * the document's content". That turned a deliberate deletion into a fight: the buffer was emptied, the
       * document had not caught up for a moment, the fill put the text back, the user deleted again — the
       * note visibly jittered. The diff is the right mechanism; a resurrection is not.
       */
      this.writtenEditorText = null;
    }
    this.attach();
  }

  /**
   * Runs an editor write with the viewport held in place.
   *
   * The restore runs *last*, after any cursor restoration, because keeping the cursor visible is itself a
   * scroll: without this order the pane jumps to the cursor even though the reader had scrolled elsewhere.
   */
  private aroundEditorWrite(write: () => void): void {
    const restore = this.deps.preserveViewport?.();
    try { write(); }
    finally { restore?.(); }
  }

  attach(): void {
    if (this.attached) return;
    this.observer = (event, transaction) => {
      // Welcomes and bridge-produced edits never produce editor deltas. The welcome carries the whole
      // document and would otherwise re-insert text the editor already shows; the local bridge already
      // wrote whatever change it made, and reading it back would echo as a second operation.
      if (transaction.origin === HOT_EDITOR_ORIGIN || transaction.origin === HOT_WELCOME_ORIGIN) return;
      this.applyDeltaToEditor(event.delta as Delta);
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
   * A brand-new note has no remote content, so the file *is* the first revision. Two details come from a
   * real device:
   *
   * - the text is passed in rather than read from the editor, because a mobile pane can hand back an
   *   editor whose buffer is not loaded yet. Seeding "from the editor" then seeds nothing, and a note
   *   that was opened hot never reaches R2 at all until someone types into it;
   * - after seeding, an editor that is still empty is filled from the document. The insert is marked with
   *   this bridge's own origin, so the observer deliberately does not echo it back — which would leave the
   *   pane showing an empty file while the document holds its content.
   *
   * Seeding only when the document is empty is what keeps this from becoming "push my whole file at
   * everyone" on every join.
   */
  async seedFromTextIfEmpty(text: string): Promise<boolean> {
    if (this.body.length > 0 || text.length === 0) return false;
    const update = await this.transact(() => this.body.insert(0, text));
    if (this.deps.editor.getValue().length === 0 && this.body.length > 0) this.replaceEditorText(this.body.toString());
    // The seed is an edit like any other: it has to be *sent*. An earlier version only inserted it into
    // the document, which left a brand-new note with its content in the CRDT and nothing in R2 — and then
    // the next keystroke diffed against the seeded text and uploaded only the new characters, so the
    // first revision of a new file was missing its beginning.
    if (update === null) return false;
    await this.deps.onLocalUpdate(update, this.nextOperationId());
    return true;
  }

  /** The editor this bridge is bound to, for callers that have to place it somewhere else. */
  editorInstance(): Editor { return this.deps.editor; }

  /**
   * Applies a full CRDT state (a `welcome`) and reconciles the editor with what is now in the document.
   *
   * The welcome is the *first* state the room sends, and a desktop pane that already shows the file's
   * body must not have that body re-inserted: an earlier version applied the welcome's full-text insert
   * delta on top of an editor that already displayed the same text, which is exactly how the mobile
   * rollout started duplicating user content on every desktop open. The observer therefore skips this
   * origin, and this method fills the editor from the document only when the two still differ — never
   * as a delta.
   */
  applyState(state: string): void {
    const before = this.body.toString();
    this.applyEncoded(state, "state");
    const after = this.body.toString();
    if (after === before) return;
    /**
     * The editor must show what the document holds *after* the welcome, but only when the editor is not
     * already showing it. A pane that already agrees needs no write at all; rewriting it would also move
     * the viewport and is the jump-to-the-top that a reader reported. The recorded-write flag then makes
     * the editor's own change event a no-op so the document does not echo back through `handleEditorChange`.
     */
    if (this.deps.editor.getValue() !== after) this.replaceEditorText(after);
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
   */
  private applyEncoded(payload: string, what: string): void {
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
    }
  }

  /**
   * Reconciles the editor with the document after a local change event.
   *
   * The change event has already updated the editor, so this is a *read* of the new value, not a
   * mutation: it turns "the editor now says X" into the smallest CRDT edit that says the same thing.
   */
  async handleEditorChange(): Promise<void> {
    if (this.applying) return;
    const current = this.deps.editor.getValue();
    if (this.writtenEditorText !== null && current === this.writtenEditorText) {
      // Nothing has changed in *this* buffer since the bridge last looked at it: either our own write being
      // reported back, or an event for an editor that is not showing anything new.
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
    if (update !== null) await this.deps.onLocalUpdate(update, this.nextOperationId());
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

  /**
   * Translates a Yjs text delta into editor ranges.
   *
   * The deltas describe operations against the document's old text. Each part either:
   *
   * - **retain** `n`: skip `n` source characters (the document kept them, so the cursor moves on);
   * - **insert** `s`: add `s` output characters, consuming **nothing** from the source;
   * - **delete** `n`: drop `n` source characters, consuming them.
   *
   * The earlier version advanced `index` after an insert and forgot to advance after a delete, which
   * broke composite transactions like `retain 1 + insert XY + retain 2 + delete 1`: the trailing delete
   * landed on the wrong source range, the editor and the document forked, and the next correct remote
   * edit produced a divergent state that the only honest repair — a handoff — refused. The index must
   * follow the source cursor, not the output.
   */
  private applyDeltaToEditor(delta: Delta): void {
    const before = this.deps.editor.getValue();
    const changes: Array<{ from: EditorPosition; to: EditorPosition; text: string }> = [];
    let index = 0;
    for (const part of delta) {
      if (part.retain !== undefined) {
        index += part.retain;
        continue;
      }
      if (part.insert !== undefined) {
        const inserted = textOf(part.insert);
        changes.push({ from: this.positionAt(before, index), to: this.positionAt(before, index), text: inserted });
        // Insert writes into the output without consuming source characters; the cursor stays put.
        continue;
      }
      if (part.delete !== undefined) {
        changes.push({ from: this.positionAt(before, index), to: this.positionAt(before, index + part.delete), text: "" });
        // Delete consumes `delete` characters from the source, so the cursor moves past them.
        index += part.delete;
      }
    }
    if (changes.length === 0) return;
    this.applying = true;
    try {
      this.aroundEditorWrite(() => this.deps.editor.transaction({ changes }, HOT_EDITOR_ORIGIN));
      this.writtenEditorText = this.deps.editor.getValue();
    } catch (error) {
      this.deps.debug?.(`hot editor transaction failed: ${error instanceof Error ? error.message : "unknown"}`);
    } finally {
      this.applying = false;
    }
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






