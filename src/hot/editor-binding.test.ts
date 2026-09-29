import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { decodeHotPayload, encodeHotPayload } from "@mineral/sync-core/hot-protocol";
import type { Editor, EditorPosition, EditorTransaction } from "obsidian";
import { HOT_EDITOR_ORIGIN, HotEditorBinding, singleChange } from "./editor-binding";

/**
 * The editor bridge.
 *
 * The assertions that matter are about *shape*: a remote edit must arrive as a ranged transaction (a
 * whole-document replace would destroy the cursor, the selection, and the undo history), and a local
 * edit must become the smallest CRDT change that says the same thing, with no echo back into the
 * editor.
 */

/** The smallest editor that behaves like Obsidian's for the calls this bridge makes. */
class FakeEditor {
  transactions: EditorTransaction[] = [];
  origins: Array<string | undefined> = [];
  constructor(public value = "") {}

  getValue(): string { return this.value; }

  setValue(next: string): void { this.value = next; }

  transaction(tx: EditorTransaction, origin?: string): void {
    this.transactions.push(tx);
    this.origins.push(origin);
    const applied = [...(tx.changes ?? [])]
      .map(change => ({
        from: this.offsetAt(change.from!),
        to: this.offsetAt(change.to!),
        text: change.text ?? "",
      }))
      .sort((left, right) => right.from - left.from);
    for (const change of applied) {
      this.value = this.value.slice(0, change.from) + change.text + this.value.slice(change.to);
    }
  }

  offsetAt(position: EditorPosition): number {
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

function bindingFor(editor: FakeEditor, onLocalUpdate: (update: string, id: string) => void = () => {}) {
  const updates: Array<{ update: string; id: string }> = [];
  const binding = new HotEditorBinding({
    editor: editor as unknown as Editor,
    onLocalUpdate: (update, id) => { updates.push({ update, id }); onLocalUpdate(update, id); },
    nextOperationId: () => `op-${updates.length + 1}`,
  });
  binding.attach();
  return { binding, updates };
}

describe("singleChange", () => {
  it("finds the smallest replacement", () => {
    expect(singleChange("hello", "hello world")).toEqual({ index: 5, remove: 0, insert: " world" });
    expect(singleChange("hello world", "hello")).toEqual({ index: 5, remove: 6, insert: "" });
    expect(singleChange("abc", "axc")).toEqual({ index: 1, remove: 1, insert: "x" });
    expect(singleChange("same", "same")).toEqual({ index: 4, remove: 0, insert: "" });
    expect(singleChange("", "new")).toEqual({ index: 0, remove: 0, insert: "new" });
  });

  it("never splits a surrogate pair", () => {
    // A cut inside a surrogate pair would put half a code point into the CRDT, which is a corrupted
    // document rather than a merge.
    const emoji = "😀";
    const change = singleChange(`a${emoji}b`, `a${emoji}c`);
    expect(change.index).toBe(3);
    expect(change.remove).toBe(1);
  });
});

describe("hot editor binding", () => {
  it("writes a remote update into the editor as a ranged transaction", () => {
    const editor = new FakeEditor("");
    const { binding } = bindingFor(editor);
    // The room's state arrives first, exactly as a `welcome` delivers it.
    const room = new Y.Doc();
    room.getText("markdown").insert(0, "hello");
    binding.applyState(encodeHotPayload(Y.encodeStateAsUpdate(room)));
    expect(editor.value).toBe("hello");

    const before = Y.encodeStateVector(room);
    room.getText("markdown").insert(5, " world");
    binding.applyRemote(encodeHotPayload(Y.encodeStateAsUpdate(room, before)));

    expect(editor.value).toBe("hello world");
    const transaction = editor.transactions.at(-1)!;
    expect(editor.origins.at(-1)).toBe(HOT_EDITOR_ORIGIN);
    const change = transaction.changes![0];
    // One ranged insert at the end, not a rewrite of the document.
    expect(transaction.changes).toHaveLength(1);
    expect(change.text).toBe(" world");
    expect(change.from).toEqual({ line: 0, ch: 5 });
    expect(change.to).toEqual({ line: 0, ch: 5 });
  });

  it("turns a local edit into the smallest update and does not echo it back", async () => {
    const editor = new FakeEditor("");
    const { binding, updates } = bindingFor(editor);
    editor.value = "line one\n";
    await binding.handleEditorChange();
    expect(updates).toHaveLength(1);
    expect(binding.text()).toBe("line one\n");
    expect(editor.transactions).toHaveLength(0);

    // The editor reporting our own applied write must not become a second operation.
    editor.value = "line one\nline two\n";
    await binding.handleEditorChange();
    expect(updates).toHaveLength(2);
    const echoed = await binding.handleEditorChange();
    expect(updates).toHaveLength(2);
    expect(echoed).toBeUndefined();

    // A peer applying the same updates converges on the same text.
    const peer = new Y.Doc();
    for (const entry of updates) Y.applyUpdate(peer, decodeHotPayload(entry.update)!);
    expect(peer.getText("markdown").toString()).toBe("line one\nline two\n");
  });

  it("seeds an empty document from the editor exactly once", async () => {
    const editor = new FakeEditor("first revision\n");
    const { binding } = bindingFor(editor);
    expect(await binding.seedFromTextIfEmpty(editor.getValue())).toBe(true);
    expect(binding.text()).toBe("first revision\n");
    expect(await binding.seedFromTextIfEmpty(editor.getValue())).toBe(false);
  });

  it("seeds from the file when the pane's buffer has not loaded, and fills the pane afterwards", async () => {
    // A real Android pane can report an empty buffer while the file on disk has content. Seeding "from the
    // editor" then seeds nothing, and the note never reaches R2 — which is exactly what the device run
    // showed. The insert is marked with this bridge's own origin, so the observer will not echo it into
    // the editor: without the explicit fill afterwards the pane would show an empty file while the
    // document holds its content.
    const editor = new FakeEditor("");
    const { binding, updates } = bindingFor(editor);

    expect(await binding.seedFromTextIfEmpty("content from disk\n")).toBe(true);

    expect(binding.text()).toBe("content from disk\n");
    expect(editor.value).toBe("content from disk\n");
    expect(updates).toHaveLength(1);
  });

  it("applies a welcome state without inventing a local edit", async () => {
    const editor = new FakeEditor("");
    const { binding, updates } = bindingFor(editor);
    const room = new Y.Doc();
    room.getText("markdown").insert(0, "remote content\n");
    binding.applyState(encodeHotPayload(Y.encodeStateAsUpdate(room)));
    expect(editor.value).toBe("remote content\n");
    expect(updates).toHaveLength(0);
    expect(binding.text()).toBe("remote content\n");
  });
});


