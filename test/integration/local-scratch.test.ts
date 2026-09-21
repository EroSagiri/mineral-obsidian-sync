import { describe, expect, it } from "vitest";
import type { Vault } from "obsidian";
import { ensureFolderTree, resolveLocalScratch } from "../../src/dev/integration/local-scratch";
import { IntegrationTestNamespace } from "../../src/dev/integration/test-namespace";
import { createFakeVault } from "./fake-vault";
import type { FakeVault } from "./fake-vault";
import { RUN_ID } from "./harness";

const namespace = (): IntegrationTestNamespace => IntegrationTestNamespace.fromRunId(RUN_ID);
const asVault = (vault: FakeVault): Vault => vault as unknown as Vault;

describe("local scratch root resolution", () => {
  it("prefers the hidden run root and reports a clean probe trail", async () => {
    const vault = createFakeVault();
    const resolution = await resolveLocalScratch(asVault(vault), namespace(), "sync");

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.scratch.kind).toBe("hidden");
    expect(resolution.scratch.root).toBe(".mineral-sync-test/20260922T001500Z/convergence/");
    expect(resolution.scratch.clientPrefix).toBe("sync");
    expect(resolution.scratch.objectRoot).toBe(".mineral-sync-test/20260922T001500Z/");
    expect(resolution.scratch.key("test-file.md")).toBe(".mineral-sync-test/20260922T001500Z/convergence/test-file.md");
    expect(resolution.scratch.diagnostics).toContain("hidden:modifyBinary=ok");

    // The probe file lives outside the scenario root, so it can never enter a plan.
    expect([...vault.files.keys()].every((key) => key.startsWith(".mineral-sync-test/20260922T001500Z/"))).toBe(true);
    expect([...vault.files.keys()].some((key) => key.startsWith(resolution.scratch.root))).toBe(false);
  });

  it("falls back to a visible run root when Obsidian refuses the dot-directory", async () => {
    const vault = createFakeVault({}, { refuseDotFolders: true });
    const resolution = await resolveLocalScratch(asVault(vault), namespace(), "sync");

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.scratch.kind).toBe("fallback");
    expect(resolution.scratch.root).toBe("private/mineral-sync-test-local/20260922T001500Z/convergence/");
    // The remote prefix absorbs the run root, so object keys still land inside the test prefix.
    expect(resolution.scratch.clientPrefix).toBe("sync/.mineral-sync-test/20260922T001500Z/");
    expect(resolution.scratch.objectRoot).toBe(".mineral-sync-test/20260922T001500Z/");
    expect(resolution.scratch.diagnostics.some((entry) => entry.startsWith("hidden:") && entry.includes("FAILED"))).toBe(true);
    expect(vault.folders.has("private")).toBe(true);
    expect(vault.folders.has("private/mineral-sync-test-local/20260922T001500Z/convergence")).toBe(true);
  });

  it("reports the full probe trail when no local root is usable", async () => {
    const vault = createFakeVault();
    const broken = {
      ...vault,
      createFolder: async () => {
        throw new Error("EACCES: permission denied");
      },
      adapter: {
        exists: async () => false,
        mkdir: async () => {
          throw new Error("EACCES: permission denied");
        },
        stat: async () => null,
      },
    } as unknown as FakeVault;

    const resolution = await resolveLocalScratch(asVault(broken), namespace(), "sync");
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.diagnostics.some((entry) => entry.startsWith("hidden:create-folders=FAILED"))).toBe(true);
    expect(resolution.diagnostics.some((entry) => entry.startsWith("fallback:create-folders=FAILED"))).toBe(true);
  });

  it("creates every ancestor level, because createFolder is not recursive", async () => {
    const vault = createFakeVault();
    await ensureFolderTree(asVault(vault), "a/b/c/");
    expect([...vault.folders].sort()).toEqual(["a", "a/b", "a/b/c"]);
    // Idempotent on a second call.
    await ensureFolderTree(asVault(vault), "a/b/c");
    expect(vault.folders.has("a/b/c")).toBe(true);
  });

  it("refuses a vault whose createBinary cannot see a created folder", async () => {
    const vault = createFakeVault();
    const noIndex = {
      ...vault,
      createBinary: async (path: string, bytes: ArrayBuffer) => {
        vault.files.set(path, { bytes: new Uint8Array(bytes.slice(0)), mtime: 1 });
        return { path, stat: { size: bytes.byteLength, mtime: 1 } };
      },
      getFileByPath: () => null,
    } as unknown as FakeVault;

    const resolution = await resolveLocalScratch(asVault(noIndex), namespace(), "sync");
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.diagnostics.some((entry) => entry.includes("getFileByPath=FAILED"))).toBe(true);
  });
});
