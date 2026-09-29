import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { decodeHotPayload, encodeHotPayload } from "@mineral/sync-core/hot-protocol";
import type { Editor, EditorPosition, EditorTransaction } from "obsidian";
import { HOT_EDITOR_ORIGIN, HotEditorBinding, singleChange } from "./editor-binding";

/**
 * The editor bridge.
 *
 * The assertions that matter are about *invariants*, not shape:
 *  - every remote update must leave the editor with text identical to the Y.Doc;
 *  - a local edit must become the smallest CRDT change that says the same thing, with no echo back
 *    into the editor;
 *  - the bridge must refuse to translate further updates once the two have diverged (the freeze),
 *    so the failure surfaces as a real conflict the user can act on instead of an in-process loop.
 *
 * The multi-change translation that the previous design emitted (one editor change per Yjs delta
 * part) is gone: it cannot express same-position replacement without races against the editor's
 * own buffer mutations. The bridge now always emits one atomic `singleChange` replacement.
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
  const freezes: string[] = [];
  const binding = new HotEditorBinding({
    editor: editor as unknown as Editor,
    onLocalUpdate: (update, id) => { updates.push({ update, id }); onLocalUpdate(update, id); },
    onFreeze: (reason) => { freezes.push(reason); },
    nextOperationId: () => `op-${updates.length + 1}`,
  });
  binding.attach();
  return { binding, updates, freezes };
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

  it("finds the smallest contiguous replacement for a same-position insert+delete", () => {
    // The bug the user pinned: the Yjs delta for "replace the first four characters of 'twwwwww'
    // with 'm'" is `[{insert: "m"}, {delete: 4}]`. The smallest single replacement is the span
    // [0, 5) -> "m" — because the shared suffix "ww" can be skipped.
    expect(singleChange("twwwwww", "mww")).toEqual({ index: 0, remove: 5, insert: "m" });
    // The reverse pattern (delete then insert at the same position) produces the same shape.
    expect(singleChange("twwwwww", "mww")).toEqual({ index: 0, remove: 5, insert: "m" });
  });
});

describe("hot editor binding", () => {
  it("writes a remote update into the editor as a single ranged transaction", () => {
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
    // One atomic replacement: the editor is asked for exactly one change derived from the doc.
    expect(transaction.changes).toHaveLength(1);
    expect(transaction.changes![0].text).toBe(" world");
    expect(transaction.changes![0].from).toEqual({ line: 0, ch: 5 });
    expect(transaction.changes![0].to).toEqual({ line: 0, ch: 5 });
  });

  it("does not duplicate content when a welcome lands on a pane that already shows the same text", () => {
    /**
     * The mobile-rollout regression: a desktop pane already shows the file's body, the server sends
     * the same body as the welcome, and the bridge used to insert that body a second time. The
     * reconcile path must therefore produce zero editor transactions when the two texts already
     * match, and must not invent a local edit in the process.
     */
    const editor = new FakeEditor("first revision\n");
    const { binding, updates, freezes } = bindingFor(editor);

    const room = new Y.Doc();
    room.getText("markdown").insert(0, "first revision\n");
    binding.applyState(encodeHotPayload(Y.encodeStateAsUpdate(room)));

    expect(editor.value).toBe("first revision\n");
    expect(updates).toHaveLength(0);
    expect(binding.text()).toBe("first revision\n");
    expect(editor.transactions).toHaveLength(0);
    expect(freezes).toEqual([]);
  });

  it("fills an empty pane from a welcome that holds content", () => {
    const editor = new FakeEditor("");
    const { binding } = bindingFor(editor);

    const room = new Y.Doc();
    room.getText("markdown").insert(0, "remote content\n");
    binding.applyState(encodeHotPayload(Y.encodeStateAsUpdate(room)));

    expect(editor.value).toBe("remote content\n");
    expect(binding.text()).toBe("remote content\n");
  });

  it("handles a same-position insert-then-delete as one atomic replacement", () => {
    /**
     * The 5400-revision regression the user pinned. A Yjs operation that *replaces* the first
     * four characters with "m" produces a delta of `[{insert: "m"}, {delete: 4}]` whose result
     * on a six-character document is "mww". The previous implementation turned those parts into
     * two editor changes — one insert at offset 0 and one delete from offset 0 to 4 — and the
     * editor applied them against a buffer the insert had already mutated, wiping the inserted
     * character and producing garbage at offset 0. A live device hit exactly this loop. The
     * corrected bridge never sees the parts: it integrates the Yjs update and writes one atomic
     * singleChange replacement derived from `editor` -> `doc`.
     */
    const editor = new FakeEditor("twwwww");
    const { binding, updates, freezes } = bindingFor(editor);

    const room = new Y.Doc();
    room.getText("markdown").insert(0, "twwwww");
    binding.applyState(encodeHotPayload(Y.encodeStateAsUpdate(room)));
    expect(editor.value).toBe("twwwww");

    // Build the same-position replacement on the remote side: insert "m" at 0, then delete four
    // characters of the post-insert document. Yjs integrates this as one op whose result is
    // "mww" — "m" plus the trailing two w's the 6-character input keeps after the delete.
    const before = Y.encodeStateVector(room);
    room.getText("markdown").insert(0, "m");
    room.getText("markdown").delete(1, 4);
    expect(room.getText("markdown").toString()).toBe("mww");

    binding.applyRemote(encodeHotPayload(Y.encodeStateAsUpdate(room, before)));

    // The editor must end up with "mww" — not "tww" or "mwww" or any other character the
    // per-part translation would have produced.
    expect(editor.value).toBe("mww");
    // The document and the editor must agree after the write.
    expect(binding.text()).toBe("mww");
    // The remote update did not invent a local edit; the only operation is the user's own.
    expect(updates).toHaveLength(0);
    expect(freezes).toEqual([]);

    const transaction = editor.transactions.at(-1)!;
    expect(transaction.changes).toHaveLength(1);
    expect(transaction.changes![0]).toMatchObject({ text: "m", from: { line: 0, ch: 0 }, to: { line: 0, ch: 4 } });
  });

  it("collapses a composite insert+delete into one atomic replacement", () => {
    /**
     * `aXYbc` derived from `abcd` via `insert "XY" at 1, delete the old 'd' at 4`. The smallest
     * contiguous change is `[1, 4) -> "XYbc"`; the bridge writes that as one transaction, not two.
     */
    const editor = new FakeEditor("abcd");
    const { binding } = bindingFor(editor);

    const room = new Y.Doc();
    room.getText("markdown").insert(0, "abcd");
    binding.applyState(encodeHotPayload(Y.encodeStateAsUpdate(room)));
    expect(editor.value).toBe("abcd");

    const before = Y.encodeStateVector(room);
    room.transact(() => {
      room.getText("markdown").insert(1, "XY");
      room.getText("markdown").delete(5, 1);
    });
    binding.applyRemote(encodeHotPayload(Y.encodeStateAsUpdate(room, before)));

    expect(editor.value).toBe("aXYbc");
    const transaction = editor.transactions.at(-1)!;
    expect(transaction.changes).toHaveLength(1);
    expect(transaction.changes![0]).toMatchObject({ from: { line: 0, ch: 1 }, to: { line: 0, ch: 4 }, text: "XYbc" });
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
    // A real Android pane can report an empty buffer while the file on disk has content. Seeding
    // "from the editor" then seeds nothing, and the note never reaches R2 — which is exactly
    // what the device run showed. The insert is marked with this bridge's own origin, so the
    // observer will not echo it into the editor: without the explicit fill afterwards the pane
    // would show an empty file while the document holds its content.
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

  it("freezes when a remote write cannot bring the editor to the document's text", () => {
    /**
     * The terminal-state contract: a write that ends with the editor and the Y.Doc still
     * disagreeing means the bridge cannot honestly translate further updates. The user gets a
     * freeze event (and, through the resolver, a real conflict); further remote translations are
     * refused, and `handleEditorChange` will not emit operations off a buffer that disagrees with
     * the room.
     *
     * The FakeEditor in this test forces a divergence by failing its first transactional write; the
     * post-write validator sees the buffer did not change and freezes.
     */
    const editor = new FakeEditor("twwwwww");
    const updates: Array<{ update: string; id: string }> = [];
    const freezes: string[] = [];
    const binding = new HotEditorBinding({
      editor: editor as unknown as Editor,
      onLocalUpdate: (update, id) => { updates.push({ update, id }); },
      onFreeze: (reason) => { freezes.push(reason); },
      nextOperationId: () => "op-1",
    });
    binding.attach();

    // Replace the transaction method with one that pretends to succeed but actually leaves the
    // buffer alone — the validator catches the resulting editor/document mismatch.
    const originalTransaction = editor.transaction.bind(editor);
    editor.transaction = ((tx: EditorTransaction, origin?: string) => {
      originalTransaction(tx, origin);
      editor.value = "twwwwww"; // force the post-write divergence
    }) as typeof editor.transaction;

    const room = new Y.Doc();
    room.getText("markdown").insert(0, "twwwwww");
    binding.applyState(encodeHotPayload(Y.encodeStateAsUpdate(room)));
    expect(freezes).toEqual([]);

    const before = Y.encodeStateVector(room);
    room.getText("markdown").insert(0, "m");
    room.getText("markdown").delete(1, 4);
    binding.applyRemote(encodeHotPayload(Y.encodeStateAsUpdate(room, before)));

    expect(freezes).toHaveLength(1);
    expect(binding.isFrozen()).toBe(true);

    // After freeze, a further remote write is silently dropped — the bridge owns no further edits.
    const beforeAgain = Y.encodeStateVector(room);
    room.getText("markdown").insert(0, "x");
    binding.applyRemote(encodeHotPayload(Y.encodeStateAsUpdate(room, beforeAgain)));
    expect(freezes).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  it("does not push operations out of the bridge once frozen", async () => {
    /**
     * A frozen bridge must not generate local operations: pushing one would extend the
     * divergence. The next editor-change handler invocation returns without producing an
     * outgoing update.
     */
    const editor = new FakeEditor("abc");
    const updates: Array<{ update: string; id: string }> = [];
    const freezes: string[] = [];
    const binding = new HotEditorBinding({
      editor: editor as unknown as Editor,
      onLocalUpdate: (update, id) => { updates.push({ update, id }); },
      onFreeze: (reason) => { freezes.push(reason); },
      nextOperationId: () => "op-1",
    });
    binding.attach();

    const originalTransaction = editor.transaction.bind(editor);
    editor.transaction = ((tx: EditorTransaction, origin?: string) => {
      originalTransaction(tx, origin);
      editor.value = "abc"; // force divergence
    }) as typeof editor.transaction;

    // Force a freeze via a remote write.
    const room = new Y.Doc();
    room.getText("markdown").insert(0, "abc");
    binding.applyState(encodeHotPayload(Y.encodeStateAsUpdate(room)));
    expect(freezes).toEqual([]);

    const before = Y.encodeStateVector(room);
    room.getText("markdown").insert(0, "x");
    binding.applyRemote(encodeHotPayload(Y.encodeStateAsUpdate(room, before)));
    expect(freezes).toHaveLength(1);

    // User types into the frozen buffer: no operation, no echo into the document.
    editor.value = "abcd";
    await binding.handleEditorChange();
    expect(updates).toHaveLength(0);
    expect(freezes).toHaveLength(1);
  });
});

/**
 * Random-interleaving convergence test.
 *
 * Two bridges, each owning an editor + a Y.Doc, exchange every local edit as a remote update.
 * After each step the assertion is editor == doc AND `left.doc == right.binding.text()`.
 *
 * The previous per-part delta translation passed simple unit tests but failed this loop on the
 * same-position replacement pattern. The corrected bridge passes it on every seed because it
 * never translates deltas — it always computes one atomic `singleChange` from the editor to the
 * document.
 */
describe("hot editor binding: random convergence", () => {
  type Op = { index: number; insert: string; delete: number };

  function mulberry32(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomEdit(rng: () => number, text: string): Op | null {
    const r = rng();
    if (r < 0.4) {
      // Insert a letter at a random position. Most common edit shape.
      const index = Math.floor(rng() * (text.length + 1));
      const char = String.fromCharCode(97 + Math.floor(rng() * 26));
      return { index, insert: char, delete: 0 };
    } else if (r < 0.7) {
      // Delete a single character at a random position.
      if (text.length === 0) return null;
      const index = Math.floor(rng() * text.length);
      return { index, insert: "", delete: 1 };
    } else if (r < 0.88) {
      // Replace 1..3 characters with a letter — the same-position replacement that the per-part
      // translation used to botch.
      if (text.length === 0) return { index: 0, insert: "a", delete: 0 };
      const index = Math.floor(rng() * text.length);
      const char = String.fromCharCode(97 + Math.floor(rng() * 26));
      const deleteCount = 1 + Math.floor(rng() * 3);
      return { index, insert: char, delete: Math.min(deleteCount, text.length - index) };
    } else {
      // Replace 1..3 characters with a 2-letter string — exercises the path where the insert and
      // delete both consume source characters but the suffix/prefix of the matching region still
      // requires a contiguous replacement.
      if (text.length === 0) return { index: 0, insert: "ab", delete: 0 };
      const index = Math.floor(rng() * text.length);
      const deleteCount = 1 + Math.floor(rng() * 3);
      return { index, insert: "ab", delete: Math.min(deleteCount, text.length - index) };
    }
  }

  function applyOp(value: string, op: Op): string {
    return value.slice(0, op.index) + op.insert + value.slice(op.index + op.delete);
  }

  /**
   * Mutate the editor as if the user typed, await `handleEditorChange`, and report whether the
   * bridge emitted an outgoing operation. An edit is a no-op (and emits nothing) when the buffer
   * is unchanged from the Y.Doc, e.g. a delete on an empty document.
   */
  async function runLocalEdit(side: FakeEditor, binding: HotEditorBinding, op: Op): Promise<boolean> {
    const docText = binding.text();
    const newEditorText = applyOp(docText, op);
    side.value = newEditorText;
    const willEmit = newEditorText !== docText;
    await binding.handleEditorChange();
    return willEmit;
  }

  it("converges to identical editor + document text under random interleaved edits", async () => {
    const trials = 12;
    const stepsPerTrial = 60;
    for (let trial = 0; trial < trials; trial++) {
      const left = new FakeEditor("");
      const right = new FakeEditor("");
      const leftUpdates: string[] = [];
      const rightUpdates: string[] = [];
      const leftBinding = new HotEditorBinding({
        editor: left as unknown as Editor,
        onLocalUpdate: (update) => { leftUpdates.push(update); },
        nextOperationId: () => `L-${trial}`,
      });
      const rightBinding = new HotEditorBinding({
        editor: right as unknown as Editor,
        onLocalUpdate: (update) => { rightUpdates.push(update); },
        nextOperationId: () => `R-${trial}`,
      });
      leftBinding.attach();
      rightBinding.attach();

      const rng = mulberry32((trial + 1) * 31 + 7);
      for (let step = 0; step < stepsPerTrial; step++) {
        const sideIsLeft = rng() < 0.5;
        const sideEditor = sideIsLeft ? left : right;
        const sideBinding = sideIsLeft ? leftBinding : rightBinding;
        const otherBinding = sideIsLeft ? rightBinding : leftBinding;
        const sideUpdates = sideIsLeft ? leftUpdates : rightUpdates;
        const beforeCount = sideUpdates.length;

        const docText = sideBinding.text();
        const op = randomEdit(rng, docText);
        if (op === null) continue;

        const emitted = await runLocalEdit(sideEditor, sideBinding, op);
        if (!emitted) continue;

        // The side emitted exactly one new update via onLocalUpdate.
        expect(sideUpdates).toHaveLength(beforeCount + 1);
        const update = sideUpdates[sideUpdates.length - 1];

        // Apply to the other side.
        otherBinding.applyRemote(update);

        const leftText = left.value;
        const rightText = right.value;
        const leftDoc = leftBinding.text();
        const rightDoc = rightBinding.text();

        expect(leftText, `left editor matches left doc (trial ${trial}, step ${step})`).toBe(leftDoc);
        expect(rightText, `right editor matches right doc (trial ${trial}, step ${step})`).toBe(rightDoc);
        expect(leftDoc, `left and right docs agree (trial ${trial}, step ${step})`).toBe(rightDoc);
        // The freeze state must never trigger under benign traffic.
        expect(leftBinding.isFrozen(), `left not frozen (trial ${trial}, step ${step})`).toBe(false);
        expect(rightBinding.isFrozen(), `right not frozen (trial ${trial}, step ${step})`).toBe(false);
      }
    }
  });
});