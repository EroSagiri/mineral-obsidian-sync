import { describe, expect, it, vi } from "vitest";
import { Setting } from "../../test/obsidian";
import type { ConflictRecord, ResolutionIntent } from "../conflict/types";
import { CONFLICT_PROTOCOL_VERSION } from "../conflict/types";

/**
 * Minimal DOM stand-in for the modal.
 *
 * The plugin ships no DOM test environment, and adding one for a single UI file is a large dependency
 * for a small surface. The modal only needs element creation and text assignment, so the shim provides
 * exactly that and nothing more — which also means this test cannot accidentally depend on real
 * layout behaviour it would then be asserting on.
 */
class FakeElement {
  children: FakeElement[] = [];
  text = "";
  value = "";
  rows = 0;
  style: Record<string, string> = {};
  readonly listeners = new Map<string, Array<() => void>>();
  constructor(readonly tag: string) {}
  createEl(tag: string, options?: { text?: string }): FakeElement {
    const child = new FakeElement(tag);
    if (options?.text !== undefined) child.text = options.text;
    this.children.push(child);
    return child;
  }
  createDiv(): FakeElement { return this.createEl("div"); }
  empty(): void { this.children = []; this.text = ""; }
  remove(): void { /* detached in this shim */ }
  addEventListener(name: string, callback: () => void): void { const list = this.listeners.get(name) ?? []; list.push(callback); this.listeners.set(name, list); }
  /** Test helper: finds the first descendant whose text matches. */
  find(predicate: (element: FakeElement) => boolean): FakeElement | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) { const found = child.find(predicate); if (found) return found; }
    return undefined;
  }
  click(): void { for (const callback of this.listeners.get("click") ?? []) callback(); }
}

const record = (overrides: Partial<ConflictRecord> = {}): ConflictRecord => ({
  protocolVersion: CONFLICT_PROTOCOL_VERSION,
  conflictId: "conflict-identity-1",
  channel: "A".repeat(43),
  path: "notes/a.md",
  previous: { localVersion: { key: "notes/a.md", size: 10, mtime: 100 }, remoteETag: "BASE" },
  observedLocal: { key: "notes/a.md", size: 11, mtime: 200 },
  observedRemoteETag: "REMOTE",
  detectedAt: 1_700_000_000_000,
  autoMergeStatus: "manual-required",
  reason: "1 overlapping region(s)",
  snapshot: { baseAvailable: true, base: "value = A\n", local: "value = B\n", remote: "value = C\n", draft: "value = B\n" },
  ...overrides,
});

/**
 * The dependency surface is the real safety boundary: if the UI cannot reach a transport, an R2 client,
 * or the Vault, it cannot mutate data. This asserts that shape directly rather than trusting review.
 */
describe("conflict resolver UI safety", () => {
  it("is constructed from exactly three capabilities, none of which can write content", async () => {
    const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("./conflict-resolver-modal.ts", import.meta.url), "utf8"));
    const interfaceBlock = source.slice(source.indexOf("export interface ConflictResolverDependencies"), source.indexOf("type Draft"));
    // No transport, no R2 client, no Vault handle, no state store: only a read and a proposal.
    for (const forbidden of ["R2Client", "HttpTransport", "Vault ", "StateStore", "requestUrl", "putObject", "modifyBinary", "createBinary", "adapter", "fetch("]) {
      expect(interfaceBlock, `dependency interface must not expose ${forbidden}`).not.toContain(forbidden);
    }
    expect(interfaceBlock).toContain("list()");
    expect(interfaceBlock).toContain("propose(");
  });

  it("proposes an intent bound to the conflict identity and versions on screen", async () => {
    const proposed: ResolutionIntent[] = [];
    const container = new FakeElement("div");
    const { ConflictResolverModal } = await import("./conflict-resolver-modal");
    const modal = new ConflictResolverModal({} as never, {
      list: async () => [record()],
      propose: async (intent) => { proposed.push(intent); },
    });
    installModalContainer(modal, container);
    await modal.onOpen();

    const keepLocal = container.find((element) => element.tag === "button" && element.text === "Keep Local");
    expect(keepLocal).toBeDefined();
    keepLocal!.click();
    await vi.waitFor(() => expect(proposed).toHaveLength(1));

    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({
      type: "keep-local",
      conflictId: "conflict-identity-1",
      channel: "A".repeat(43),
      path: "notes/a.md",
      expectedLocalVersion: { key: "notes/a.md", size: 11, mtime: 200 },
      expectedRemoteETag: "REMOTE",
    });
    // A keep-local intent carries no content at all: the executor reads the file itself.
    expect(proposed[0]!.merged).toBeUndefined();
  });

  it("proposes keep-remote without content and without touching the remote", async () => {
    const proposed: ResolutionIntent[] = [];
    const container = new FakeElement("div");
    const { ConflictResolverModal } = await import("./conflict-resolver-modal");
    const modal = new ConflictResolverModal({} as never, { list: async () => [record()], propose: async (intent) => { proposed.push(intent); } });
    installModalContainer(modal, container);
    await modal.onOpen();
    container.find((element) => element.tag === "button" && element.text === "Keep Remote")!.click();
    await vi.waitFor(() => expect(proposed).toHaveLength(1));
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ type: "keep-remote", conflictId: "conflict-identity-1", expectedRemoteETag: "REMOTE" });
    expect(proposed[0]!.merged).toBeUndefined();
  });

  it("shows the base as unavailable instead of inventing one for a legacy conflict", async () => {
    const container = new FakeElement("div");
    const { ConflictResolverModal } = await import("./conflict-resolver-modal");
    const legacy = record({ autoMergeStatus: "base-unavailable", reason: "no merge-base snapshot was recorded for this baseline", snapshot: { baseAvailable: false, local: "local\n", remote: "remote\n" } });
    const modal = new ConflictResolverModal({} as never, { list: async () => [legacy], propose: async () => {} });
    installModalContainer(modal, container);
    await modal.onOpen();

    const unavailable = container.find((element) => element.text.includes("Merge base unavailable"));
    expect(unavailable).toBeDefined();
    // The Base panel states the absence rather than rendering a fabricated empty base.
    const placeholder = container.find((element) => element.text === "— unavailable —");
    expect(placeholder).toBeDefined();
  });

  it("edits a merged draft and proposes it with the editor's exact text", async () => {
    const proposed: ResolutionIntent[] = [];
    const container = new FakeElement("div");
    const { ConflictResolverModal } = await import("./conflict-resolver-modal");
    const modal = new ConflictResolverModal({} as never, { list: async () => [record()], propose: async (intent) => { proposed.push(intent); } });
    installModalContainer(modal, container);
    await modal.onOpen();

    container.find((element) => element.tag === "button" && element.text === "Edit Merged Result")!.click();
    await flush();
    const editor = container.find((element) => element.tag === "textarea")!;
    expect(editor).toBeDefined();
    // The draft starts from the local side, not from marker text, so Apply cannot destroy the user's text.
    expect(editor.value).toBe("value = B\n");
    editor.value = "value = BC\n";
    container.find((element) => element.tag === "button" && element.text === "Apply")!.click();
    await vi.waitFor(() => expect(proposed).toHaveLength(1));

    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ type: "merged", conflictId: "conflict-identity-1" });
    expect(proposed[0]!.merged?.content).toBe("value = BC\n");
    // Normalized storage: the editor is a text surface with no byte-level view.
    expect(proposed[0]!.merged?.encoding).toEqual({ bom: false, eol: "lf", trailingNewline: true });
    expect(proposed[0]!.merged?.sha256).toHaveLength(64);
  });
  it("reports zero conflicts without proposing anything", async () => {
    const proposed: ResolutionIntent[] = [];
    const container = new FakeElement("div");
    const { ConflictResolverModal } = await import("./conflict-resolver-modal");
    const modal = new ConflictResolverModal({} as never, { list: async () => [], propose: async (intent) => { proposed.push(intent); } });
    installModalContainer(modal, container);
    await modal.onOpen();
    expect(container.find((element) => element.text.includes("No sync conflicts"))).toBeDefined();
    expect(proposed).toHaveLength(0);
  });

  it("pages through multiple conflicts", async () => {
    const first = record({ conflictId: "one", path: "a.md" });
    const second = record({ conflictId: "two", path: "b.md" });
    const container = new FakeElement("div");
    const { ConflictResolverModal } = await import("./conflict-resolver-modal");
    const modal = new ConflictResolverModal({} as never, { list: async () => [first, second], propose: async () => {} });
    installModalContainer(modal, container);
    // Earlier tests in this file also register Setting controls, so only those added here are used.
    const before = Setting.registered.length;
    await modal.onOpen();
    // The heading text is rendered per conflict, so it is the observable signal that paging happened.
    expect(container.find((element) => element.text === "a.md")).toBeDefined();
    expect(Setting.registered.length).toBeGreaterThan(before);
    const next = Setting.registered.slice(before).find((button) => button.text === "Next");
    expect(next).toBeDefined();
    next!.callback();
    expect(container.find((element) => element.text === "b.md")).toBeDefined();
    expect(container.find((element) => element.text === "a.md")).toBeUndefined();
  });
});

const flush = async (): Promise<void> => { for (let index = 0; index < 64; index++) await Promise.resolve(); };

/**
 * The real `Modal` base class owns `contentEl`; this assigns the shim in its place so the modal's own
 * code runs unmodified.
 */
function installModalContainer(modal: { contentEl: unknown }, container: FakeElement): void { (modal as { contentEl: FakeElement }).contentEl = container; }
