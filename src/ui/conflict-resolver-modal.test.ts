import { describe, expect, it, vi } from "vitest";
import { FakeElement, flush, installModalContainer } from "../../test/dom";
import type { ConflictRecord, ResolutionIntent } from "../conflict/types";
import { CONFLICT_PROTOCOL_VERSION } from "../conflict/types";

/**
 * The resolver's interaction, driven through its own `onOpen`.
 *
 * The properties under test are the ones the rework promised: the default screen is not a four-pane
 * diff, conflict markers are not on it, the two sides are named by role, an append-versus-append
 * conflict offers "keep both", and nothing technical is shown until it is asked for.
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

async function open(records: ConflictRecord[], propose: (intent: ResolutionIntent) => Promise<void> = async () => {}): Promise<FakeElement> {
  const container = new FakeElement("div");
  const { ConflictResolverModal } = await import("./conflict-resolver-modal");
  const modal = new ConflictResolverModal({} as never, { list: async () => records, propose });
  installModalContainer(modal, container);
  await modal.onOpen();
  return container;
}

/** The dependency surface is the real safety boundary: if the UI cannot reach a transport, an R2
 * client, or the Vault, it cannot mutate data. */
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
});

describe("conflict resolver presentation", () => {
  it("shows a plain-language headline and the two sides, not a four-pane diff", async () => {
    const container = await open([record()]);
    expect(container.find((element) => element.text === "Mineral Sync")).toBeDefined();
    expect(container.find((element) => element.text === "notes/a.md")).toBeDefined();
    expect(container.find((element) => element.text === "1 change needs your attention")).toBeDefined();
    // No Base / Local / Remote / Merged panel titles anywhere in the default view.
    for (const title of ["Base", "Local", "Remote", "Merged"]) {
      expect(container.visibleText.split("\n"), title).not.toContain(title);
    }
    expect(container.find((element) => element.text === "This device added")).toBeDefined();
    expect(container.find((element) => element.text === "Other version added")).toBeDefined();
  });

  it("never shows conflict markers or raw ETags in the default view", async () => {
    const container = await open([record()]);
    expect(container.visibleText).not.toContain("<<<<<<<");
    expect(container.visibleText).not.toContain("=======");
    expect(container.visibleText).not.toContain(">>>>>>>");
    expect(container.visibleText).not.toContain("BASE");
    expect(container.visibleText).not.toContain("REMOTE");
    expect(container.visibleText).not.toContain("conflict-identity-1");
  });

  it("keeps Technical details collapsed, and holds the raw facts there", async () => {
    const container = await open([record()]);
    const details = container.find((element) => element.tag === "details")!;
    expect(details).toBeDefined();
    expect(details.open).toBe(false);
    expect(details.find((element) => element.text === "Technical details")).toBeDefined();
    // The raw marker draft and the identity are reachable, but only inside the collapsed block.
    expect(details.allText).toContain("<<<<<<< LOCAL");
    expect(details.allText).toContain("Conflict ID");
    expect(details.allText).toContain("Remote ETag");
    expect(details.allText).toContain("Raw merge draft");
  });

  it("previews the merged result and offers Keep both as the primary action for two additions", async () => {
    const proposed: ResolutionIntent[] = [];
    const container = await open([record()], async (intent) => { proposed.push(intent); });

    const preview = container.find((element) => element.classes.has("mineral-sync-conflicts__result"))!;
    expect(preview.text).toBe("windows\nsf\nfrom windows\noppo\n");

    const keepBoth = container.button("Keep both")!;
    expect(keepBoth).toBeDefined();
    expect(keepBoth.classes.has("mod-cta")).toBe(true);
    keepBoth.click();
    await vi.waitFor(() => expect(proposed).toHaveLength(1));

    expect(proposed[0]).toMatchObject({ type: "merged", conflictId: "conflict-identity-1", path: "notes/a.md", expectedRemoteETag: "REMOTE" });
    expect(proposed[0]!.merged?.content).toBe("windows\nsf\nfrom windows\noppo\n");
    expect(proposed[0]!.merged?.content).not.toContain("<<<<<<<");
  });

  it("does not offer Keep both when a region was replaced, and defaults to editing", async () => {
    const container = await open([replaced()]);
    expect(container.button("Keep both")).toBeUndefined();
    expect(container.button("Keep current device")).toBeDefined();
    expect(container.button("Keep other version")).toBeDefined();
    expect(container.button("Edit manually")!.classes.has("mod-cta")).toBe(true);
    expect(container.visibleText).not.toContain("<<<<<<<");
  });

  it("proposes keep-local and keep-remote without content", async () => {
    const proposed: ResolutionIntent[] = [];
    const container = await open([replaced()], async (intent) => { proposed.push(intent); });
    container.button("Keep current device")!.click();
    await vi.waitFor(() => expect(proposed).toHaveLength(1));
    expect(proposed[0]).toMatchObject({ type: "keep-local", expectedLocalVersion: { key: "notes/a.md", size: 11, mtime: 200 }, expectedRemoteETag: "REMOTE" });
    expect(proposed[0]!.merged).toBeUndefined();
  });

  it("edits the result rather than markers, and proposes the editor's exact text", async () => {
    const proposed: ResolutionIntent[] = [];
    const container = await open([record()], async (intent) => { proposed.push(intent); });
    container.button("Edit manually")!.click();
    await flush();

    const editor = container.find((element) => element.tag === "textarea")!;
    expect(editor).toBeDefined();
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

  it("leaves the result untouched when the manual editor is cancelled", async () => {
    const proposed: ResolutionIntent[] = [];
    const container = await open([record()], async (intent) => { proposed.push(intent); });
    container.button("Edit manually")!.click();
    await flush();
    container.find((element) => element.tag === "textarea")!.value = "changed\n";
    container.button("Cancel")!.click();
    await flush();
    expect(proposed).toHaveLength(0);
    expect(container.button("Keep both")).toBeDefined();
  });

  it("explains a deletion conflict and offers its two version-bound decisions", async () => {
    const container = await open([record({
      observedRemoteDeletion: { path: "notes/a.md", deletedRemoteETag: "DELETED", createdAt: "2026-01-01T00:00:00.000Z", objectPresent: true },
      snapshot: { baseAvailable: true, local: "changed\n" },
    })]);
    expect(container.find((element) => element.text === "The other device deleted this file, while this device has changes to it.")).toBeDefined();
    expect(container.button("Keep this device's file")).toBeDefined();
    expect(container.button("Accept the deletion")).toBeDefined();
    expect(container.button("Keep both")).toBeUndefined();
  });

  it("states a missing common ancestor instead of rendering an empty one", async () => {
    const container = await open([record({ autoMergeStatus: "base-unavailable", snapshot: { baseAvailable: false, local: "local\n", remote: "remote\n" } })]);
    expect(container.find((element) => element.text.includes("common ancestor"))).toBeDefined();
    const technical = container.find((element) => element.tag === "details")!;
    expect(technical.allText).toContain("not recorded");
  });

  it("reports an empty queue without proposing anything", async () => {
    const proposed: ResolutionIntent[] = [];
    const container = await open([], async (intent) => { proposed.push(intent); });
    expect(container.find((element) => element.text.includes("No conflicts"))).toBeDefined();
    expect(proposed).toHaveLength(0);
  });

  it("pages through several conflicts", async () => {
    const container = await open([record({ conflictId: "one", path: "a.md" }), record({ conflictId: "two", path: "b.md" })]);
    expect(container.find((element) => element.text === "a.md")).toBeDefined();
    expect(container.find((element) => element.text === "Conflict 1 of 2")).toBeDefined();
    container.button("Next conflict")!.click();
    await flush();
    expect(container.find((element) => element.text === "b.md")).toBeDefined();
    expect(container.find((element) => element.text === "a.md")).toBeUndefined();
    expect(container.find((element) => element.text === "Conflict 2 of 2")).toBeDefined();
  });
});
