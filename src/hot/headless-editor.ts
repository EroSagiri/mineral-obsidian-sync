import type { Editor, EditorPosition, EditorTransaction } from "obsidian";

/**
 * An editor with no screen.
 *
 * A conflict can be resolved for a file that is not open in any pane — a restored conflict, or a handoff
 * that never finished — and the machinery still needs *an* editor to carry the document. This one keeps the
 * text and applies changes the way a real editor does, because the bridge decides whether a change is its
 * own echo by comparing the editor's value with what it last wrote: a carrier that ignored edits would look
 * like it never changed, and the resolution's content would be swallowed as an echo.
 */
export class HeadlessEditor {
  constructor(private value = "") {}

  getValue(): string { return this.value; }

  setValue(next: string): void { this.value = next; }

  /** Applies a transaction's changes, newest edit first, exactly as the bridge expects. */
  transaction(transaction: EditorTransaction, _origin?: string): void {
    const applied = [...(transaction.changes ?? [])]
      .map(change => ({
        from: this.offsetAt(change.from ?? { line: 0, ch: 0 }),
        to: this.offsetAt(change.to ?? { line: 0, ch: 0 }),
        text: change.text ?? "",
      }))
      .sort((left, right) => right.from - left.from);
    for (const change of applied) {
      this.value = this.value.slice(0, change.from) + change.text + this.value.slice(change.to);
    }
  }

  /** Present because Obsidian's editor has it; a resolution never needs to place a cursor. */
  setCursor(_position: EditorPosition): void {}

  private offsetAt(position: EditorPosition): number {
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

/** The shape the hot layer needs; the cast is the price of standing in for Obsidian's own editor. */
export const asEditor = (editor: HeadlessEditor): Editor => editor as unknown as Editor;
