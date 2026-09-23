import { describe, expect, it, vi } from "vitest";
import { FakeElement, flush, installModalContainer } from "../../test/dom";
import type { ConflictRecord, ResolutionIntent } from "../conflict/types";
import { CONFLICT_PROTOCOL_VERSION } from "../conflict/types";

/**
 * The resolver's three-page interaction.
 *
 * The promises under test: the first screen shows a prepared result and one primary action, the two
 * sides are only shown after asking for them, the overwrite-a-side actions only exist on that second
 * page, markers never leave technical details, and a resolved conflict hands over to the next one.
 */

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
  snapshot: {
    baseAvailable: true,
    base: "windows\nsf\n",
    local: "windows\nsf\nfrom windows\n",
    remote: "windows\nsf\noppo\n",
    draft: "windows\nsf\n<<<<<<< LOCAL\nfrom windows\n=======\noppo\n>>>>>>> REMOTE\n",
  },
  ...overrides,
});

const replaced = (): ConflictRecord => record({
  snapshot: { baseAvailable: true, base: "value = A\n", local: "value = B\n", remote: "value = C\n", draft: "value = B\n" },
});

/** The live incident: the other side only added a final newline. */
const incident = (): ConflictRecord => record({
  snapshot: { baseAvailable: true, base: "windows\nwindows", local: "windows\nwindows\nandroid\nandroid\n", remote: "windows\nwindows\n", draft: "" },
});

async function open(records: ConflictRecord[], propose: (intent: ResolutionIntent) => Promise<void> = async () => {}): Promise<{ container: FakeElement; modal: { close(): void } }> {
  const container = new FakeElement("div");
  const { ConflictResolverModal } = await import("./conflict-resolver-modal");
  const modal = new ConflictResolverModal({} as never, { list: async () => records, propose });
  installModalContainer(modal, container);
  await modal.onOpen();
  return { container, modal: modal as unknown as { close(): void } };
}

describe("conflict resolver UI safety", () => {
  it("is constructed from exactly two capabilities, none of which can write content", async () => {
    const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("./conflict-resolver-modal.ts", import.meta.url), "utf8"));
    const interfaceBlock = source.slice(source.indexOf("export interface ConflictResolverDependencies"), source.indexOf("type Draft"));
    for (const forbidden of ["R2Client", "HttpTransport", "Vault ", "StateStore", "requestUrl", "putObject", "modifyBinary", "createBinary", "adapter", "fetch("]) {
      expect(interfaceBlock, `dependency interface must not expose ${forbidden}`).not.toContain(forbidden);
    }
    expect(interfaceBlock).toContain("list()");
    expect(interfaceBlock).toContain("propose(");
  });

  it("styles itself from theme variables only", async () => {
    const { CONFLICT_RESOLVER_CSS } = await import("./conflict-styles");
    const declarations = CONFLICT_RESOLVER_CSS.split("\n").filter((line) => line.includes(":") && !line.includes("{"));
    for (const declaration of declarations) {
      expect(declaration, declaration).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(declaration, declaration).not.toMatch(/\brgba?\(/i);
    }
    // The side-by-side layout depends on the grid, and both surfaces must be theme-driven.
    expect(CONFLICT_RESOLVER_CSS).toContain("grid-template-columns");
    expect(CONFLICT_RESOLVER_CSS).toContain("var(--background-secondary)");
    expect(CONFLICT_RESOLVER_CSS).toContain("var(--text-muted)");
  });
});

describe("first screen: review the prepared result", () => {
  it("shows the suggested result and one primary action", async () => {
    const { container } = await open([record()]);
    expect(container.find((element) => element.text === "Suggested result")).toBeDefined();
    expect(container.find((element) => element.classes.has("mineral-sync-conflicts__result"))!.text).toBe("windows\nsf\nfrom windows\noppo\n");

    const primary = container.findAll((element) => element.tag === "button" && element.classes.has("mod-cta"));
    expect(primary.map((button) => button.text)).toEqual(["Use suggested result"]);
    expect(container.button("View differences")).toBeDefined();
    expect(container.button("Edit manually")).toBeDefined();
    // The user answers exactly one question here: is this result right?
    expect(container.visibleText).not.toContain("This device has");
    expect(container.visibleText).not.toContain("Other version has");
  });

  it("does not put the sides, the destructive choices or technical facts on it", async () => {
    const { container } = await open([record()]);
    for (const forbidden of ["Use current version", "Use other version", "Keep current device", "Keep other version", "Keep both", "This device added", "Other version added", "Base"]) {
      expect(container.visibleText.split("\n"), forbidden).not.toContain(forbidden);
    }
    expect(container.visibleText).not.toContain("<<<<<<<");
    expect(container.visibleText).not.toContain("REMOTE");
    expect(container.visibleText).not.toContain("conflict-identity-1");
    // No side-by-side columns exist on this page at all.
    expect(container.findAll((element) => element.classes.has("mineral-sync-conflicts__columns"))).toHaveLength(0);
  });

  it("uses no result wording at all when none could be prepared, and makes editing primary", async () => {
    const { container } = await open([replaced()]);
    expect(container.find((element) => element.text === "This change could not be merged automatically.")).toBeDefined();
    expect(container.find((element) => element.text === "Suggested result")).toBeUndefined();
    expect(container.findAll((element) => element.tag === "button" && element.classes.has("mod-cta")).map((button) => button.text)).toEqual(["Edit manually"]);
    expect(container.button("View differences")).toBeDefined();
    expect(container.visibleText).not.toContain("Keep both");
    expect(container.visibleText).not.toContain("Use current version");
    expect(container.visibleText).not.toContain("<<<<<<<");
  });

  it("never renders the other side's newline as a change", async () => {
    const { container } = await open([incident()]);
    expect(container.find((element) => element.text === "Suggested result")).toBeDefined();
    expect(container.visibleText).not.toContain("Other version added");

    container.button("View differences")!.click();
    await flush();
    // One-sided once formatting is ignored, so only this device's own addition is shown.
    expect(container.find((element) => element.text === "Only this device changed this area")).toBeDefined();
    expect(container.findAll((element) => element.classes.has("mineral-sync-conflicts__side--other"))).toHaveLength(0);
    expect(container.visibleText).not.toContain("Other version added");
    expect(container.visibleText).not.toContain("newline\n");
  });

  it("accepts the suggested result as one intent carrying exactly that text", async () => {
    const proposed: ResolutionIntent[] = [];
    const { container } = await open([record()], async (intent) => { proposed.push(intent); });
    container.button("Use suggested result")!.click();
    await vi.waitFor(() => expect(proposed).toHaveLength(1));
    expect(proposed[0]).toMatchObject({ type: "merged", conflictId: "conflict-identity-1", path: "notes/a.md", expectedRemoteETag: "REMOTE" });
    expect(proposed[0]!.merged?.content).toBe("windows\nsf\nfrom windows\noppo\n");
  });
});

describe("second screen: differences", () => {
  it("only appears on request, and only there are the sides and the overwrite actions offered", async () => {
    const { container } = await open([record()]);
    expect(container.button("Use current version")).toBeUndefined();
    container.button("View differences")!.click();
    await flush();

    expect(container.find((element) => element.text === "Differences")).toBeDefined();
    expect(container.findAll((element) => element.classes.has("mineral-sync-conflicts__columns"))).toHaveLength(1);
    expect(container.find((element) => element.text === "This device added")).toBeDefined();
    expect(container.find((element) => element.text === "Other version added")).toBeDefined();
    expect(container.button("Use current version")).toBeDefined();
    expect(container.button("Use other version")).toBeDefined();
    expect(container.button("Back to suggested result")).toBeDefined();
    // Base belongs to technical details, never to this page's own layout.
    expect(container.visibleText.split("\n")).not.toContain("Base");
  });

  it("proposes the chosen side without content", async () => {
    const proposed: ResolutionIntent[] = [];
    const { container } = await open([record()], async (intent) => { proposed.push(intent); });
    container.button("View differences")!.click();
    await flush();
    container.button("Use current version")!.click();
    await vi.waitFor(() => expect(proposed).toHaveLength(1));
    expect(proposed[0]).toMatchObject({ type: "keep-local", expectedLocalVersion: { key: "notes/a.md", size: 11, mtime: 200 } });
    expect(proposed[0]!.merged).toBeUndefined();
  });

  it("says a formatting-only difference is formatting, with no blocks to compare", async () => {
    const whitespace = record({ snapshot: { baseAvailable: true, base: "a\nb\n", local: "a\nb \n", remote: "a\nb\t\n", draft: "" } });
    const { container } = await open([whitespace]);
    container.button("View differences")!.click();
    await flush();
    expect(container.find((element) => element.text.includes("differ only in formatting"))).toBeDefined();
    expect(container.findAll((element) => element.classes.has("mineral-sync-conflicts__hunk"))).toHaveLength(0);
  });

  it("goes back to the result page", async () => {
    const { container } = await open([record()]);
    container.button("View differences")!.click();
    await flush();
    container.button("Back to suggested result")!.click();
    await flush();
    expect(container.find((element) => element.text === "Suggested result")).toBeDefined();
    expect(container.button("Use current version")).toBeUndefined();
  });
});

describe("third screen: editing the final result", () => {
  it("opens on the suggested result, without markers, and applies exactly what it holds", async () => {
    const proposed: ResolutionIntent[] = [];
    const { container } = await open([record()], async (intent) => { proposed.push(intent); });
    container.button("Edit manually")!.click();
    await flush();

    const editor = container.find((element) => element.tag === "textarea")!;
    expect(container.find((element) => element.text === "Edit final result")).toBeDefined();
    expect(editor.value).toBe("windows\nsf\nfrom windows\noppo\n");
    expect(editor.value).not.toContain("<<<<<<<");
    editor.value = "windows\nsf\nfrom windows\n";
    container.button("Apply resolved version")!.click();
    await vi.waitFor(() => expect(proposed).toHaveLength(1));
    expect(proposed[0]).toMatchObject({ type: "merged" });
    expect(proposed[0]!.merged?.content).toBe("windows\nsf\nfrom windows\n");
    expect(proposed[0]!.merged?.encoding).toEqual({ bom: false, eol: "lf", trailingNewline: true });
    expect(proposed[0]!.merged?.sha256).toHaveLength(64);
  });

  it("opens on this device's own text when there is no result to suggest", async () => {
    const { container } = await open([replaced()]);
    container.button("Edit manually")!.click();
    await flush();
    expect(container.find((element) => element.tag === "textarea")!.value).toBe("value = B\n");
  });

  it("changes nothing when cancelled", async () => {
    const proposed: ResolutionIntent[] = [];
    const { container } = await open([record()], async (intent) => { proposed.push(intent); });
    container.button("Edit manually")!.click();
    await flush();
    container.find((element) => element.tag === "textarea")!.value = "changed\n";
    container.button("Cancel")!.click();
    await flush();
    expect(proposed).toHaveLength(0);
    expect(container.find((element) => element.text === "Suggested result")).toBeDefined();
  });
});

describe("deletion versus modification", () => {
  it("gets its own wording and its own two decisions", async () => {
    const { container } = await open([record({
      observedRemoteDeletion: { path: "notes/a.md", deletedRemoteETag: "DELETED", createdAt: "2026-01-01T00:00:00.000Z", objectPresent: true },
      snapshot: { baseAvailable: true, local: "changed\n" },
    })]);
    expect(container.find((element) => element.text === "One device deleted this note, while another device kept editing it.")).toBeDefined();
    expect(container.find((element) => element.text === "Modified version")).toBeDefined();
    expect(container.findAll((element) => element.tag === "button" && element.classes.has("mod-cta")).map((button) => button.text)).toEqual(["Keep note"]);
    expect(container.button("Delete note")).toBeDefined();
    expect(container.visibleText).not.toContain("Use current version");
    expect(container.visibleText).not.toContain("Keep both");
  });
});

describe("technical details", () => {
  it("stay collapsed on every page, and are the only place the raw facts appear", async () => {
    const { container } = await open([record()]);
    for (const page of ["View differences", "Edit manually", "View differences", "Back to suggested result"]) {
      container.button(page)?.click();
      await flush();
      const details = container.findAll((element) => element.tag === "details");
      expect(details).toHaveLength(1);
      expect(details[0]!.open).toBe(false);
      expect(details[0]!.find((element) => element.text === "Technical details")).toBeDefined();
      expect(details[0]!.allText).toContain("<<<<<<< LOCAL");
      expect(details[0]!.allText).toContain("Conflict ID");
      expect(details[0]!.allText).toContain("Raw merged draft");
    }
  });
});

describe("several conflicts", () => {
  it("reports the queue, advances automatically, and finishes", async () => {
    const proposed: ResolutionIntent[] = [];
    const first = record({ conflictId: "one", path: "a.md" });
    const second = record({ conflictId: "two", path: "b.md" });
    const { container } = await open([first, second], async (intent) => { proposed.push(intent); });

    expect(container.find((element) => element.text === "2 conflicts need attention")).toBeDefined();
    expect(container.find((element) => element.text === "1 of 2")).toBeDefined();
    expect(container.find((element) => element.text === "a.md")).toBeDefined();

    container.button("Use suggested result")!.click();
    await vi.waitFor(() => expect(proposed).toHaveLength(1));
    await flush();

    // The next conflict is presented from its own result page, not from a list.
    expect(container.find((element) => element.text === "b.md")).toBeDefined();
    expect(container.find((element) => element.text === "2 of 2")).toBeDefined();
    expect(container.find((element) => element.text === "Suggested result")).toBeDefined();
    expect(container.button("Use current version")).toBeUndefined();

    container.button("Use suggested result")!.click();
    await vi.waitFor(() => expect(proposed).toHaveLength(2));
    await flush();
    expect(container.find((element) => element.text === "All conflicts resolved")).toBeDefined();
    expect(container.button("Done")).toBeDefined();
  });

  it("closes from the final screen", async () => {
    const { container, modal } = await open([]);
    let closed = false;
    modal.close = () => { closed = true; };
    expect(container.find((element) => element.text === "All conflicts resolved")).toBeDefined();
    container.button("Done")!.click();
    expect(closed).toBe(true);
  });
});
