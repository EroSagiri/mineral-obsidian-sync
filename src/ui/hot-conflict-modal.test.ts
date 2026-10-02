import { beforeEach, describe, expect, it } from "vitest";
import { FakeElement, installModalContainer } from "../../test/dom";
import { registeredSettingButtons, shownNotices } from "../../test/obsidian";
import { HotConflictModal, type HotConflictDecision, type HotConflictEntry } from "./hot-conflict-modal";

/**
 * The hot conflict screen's one non-obvious promise.
 *
 * A path can be frozen on the hot side while a merge has already been composed on the cold side, and the
 * cold side cannot apply it: the live room is the path's only writer, so a cold write is exactly what the
 * fence prevents. That leaves the prepared text with nowhere to go unless this screen offers it. These
 * tests pin that offer down, and pin down the thing that must never change — the screen itself still
 * writes nothing. It only reports a decision; the room carries the text.
 */

const entry = (overrides: Partial<HotConflictEntry> = {}): HotConflictEntry => ({
  canonicalPath: "notes/a.md",
  reason: "conflict",
  localSize: 2,
  remoteSize: 8,
  ...overrides,
});

/** The `Setting` shim records buttons here rather than in the DOM, which is how they are pressed. */
const buttonFor = (label: string) => registeredSettingButtons().find((entry) => entry.text === label);
const labels = () => registeredSettingButtons().map((entry) => entry.text);

function openModal(
  conflicts: HotConflictEntry[],
  decide: (path: string, decision: HotConflictDecision, mergedText?: string) => Promise<{ outcome: string; detail?: string }>,
) {
  const container = new FakeElement("div");
  const modal = new HotConflictModal({} as never, conflicts, decide);
  installModalContainer(modal, container);
  modal.onOpen();
  return { modal, container };
}

const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

/**
 * Presses a button and waits for its handler.
 *
 * The modal's buttons run `async` work; the shim keeps whatever the handler returns so the rejection is
 * awaited here instead of escaping as an unhandled one.
 */
async function press(label: string): Promise<void> {
  await (buttonFor(label)!.callback() as unknown as Promise<void>);
  await settle();
}

beforeEach(() => { registeredSettingButtons().length = 0; });

describe("HotConflictModal", () => {
  it("keeps the choice binary when there is no prepared merge", () => {
    openModal([entry()], async () => ({ outcome: "resolved" }));

    expect(labels()).toEqual(["保留本机文件（写入服务器）", "采用服务器版本（覆盖本机文件）"]);
  });

  it("offers the prepared merge and hands its text to the room", async () => {
    const decisions: Array<{ decision: HotConflictDecision; text?: string }> = [];
    openModal([entry({ mergedDraft: "local\nremote\n" })], async (_path, decision, text) => {
      decisions.push({ decision, ...(text === undefined ? {} : { text }) });
      return { outcome: "resolved" };
    });

    expect(labels()).toContain("使用已准备好的合并结果");
    await press("使用已准备好的合并结果");

    // The text travels with the decision because the room cannot read it from R2 or from disk.
    expect(decisions).toEqual([{ decision: "merged", text: "local\nremote\n" }]);
  });

  it("is given no vault, transport or coordinator to write through", () => {
    // The structural guarantee behind "the UI does not write data": the constructor takes the app, the
    // rows and a decision callback, and nothing else. Asserted rather than assumed, because a future
    // change that hands the modal a writer would be invisible in every other test here.
    const container = new FakeElement("div");
    const modal = new HotConflictModal({} as never, [entry({ mergedDraft: "x" })], async () => ({ outcome: "resolved" }));
    installModalContainer(modal, container);
    modal.onOpen();

    const owned = Object.keys(modal).filter((key) => !["containerEl", "contentEl", "titleEl", "modalEl", "scope", "opened"].includes(key));
    expect(owned).toEqual(["app", "conflicts", "decide", "decided"]);
    expect((modal as unknown as { app: unknown }).app).toEqual({});
  });

  it("leaves a failed decision actionable instead of hiding it", async () => {
    openModal([entry({ mergedDraft: "x" })], async () => ({ outcome: "failed", detail: "join-refused" }));
    const before = shownNotices().length;

    await press("使用已准备好的合并结果");

    // The row stays pressable: the conflict is still there, and pretending otherwise is worse. The reason
    // reaches the user through a Notice because the `Setting` shim does not model `setDesc`.
    expect(labels()).toContain("使用已准备好的合并结果");
    expect(shownNotices().slice(before).join("\n")).toContain("join-refused");
  });
});
