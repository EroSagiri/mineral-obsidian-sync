import { describe, expect, it } from "vitest";
import { ensureParentFolders } from "./ensure-folders";

interface Entry { path: string }

function vaultOf(files: string[] = [], folders: string[] = []) {
  const fileSet = new Set(files);
  const folderSet = new Set(folders);
  // A real Vault cannot contain "a/b" as a file unless "a" exists as a folder.
  for (const path of fileSet) {
    const segments = path.split("/");
    segments.pop();
    for (let index = 1; index <= segments.length; index += 1) folderSet.add(segments.slice(0, index).join("/"));
  }
  return {
    fileSet,
    folderSet,
    getFileByPath: (path: string): Entry | null => (fileSet.has(path) ? { path } : null),
    getAbstractFileByPath: (path: string): Entry | null => (fileSet.has(path) || folderSet.has(path) ? { path } : null),
    createFolder: async (path: string): Promise<Entry> => {
      if (folderSet.has(path) || fileSet.has(path)) throw new Error(`already exists: ${path}`);
      const parent = path.split("/").slice(0, -1).join("/");
      if (parent && !folderSet.has(parent)) throw new Error(`ENOENT: ${path}`);
      folderSet.add(path);
      return { path };
    },
    adapter: {
      exists: async (path: string): Promise<boolean> => folderSet.has(path) || fileSet.has(path),
      mkdir: async (path: string): Promise<void> => {
        if (folderSet.has(path) || fileSet.has(path)) throw new Error(`already exists: ${path}`);
        const parent = path.split("/").slice(0, -1).join("/");
        if (parent && !folderSet.has(parent)) throw new Error(`ENOENT: ${path}`);
        folderSet.add(path);
      },
    },
  };
}

const asVault = (vault: unknown): Parameters<typeof ensureParentFolders>[0] => vault as Parameters<typeof ensureParentFolders>[0];

describe("ensureParentFolders", () => {
  it("does nothing for a root-level file", async () => {
    const vault = vaultOf();
    await expect(ensureParentFolders(asVault(vault), "note.md")).resolves.toEqual({ ok: true, created: [] });
    expect([...vault.folderSet]).toEqual([]);
  });

  it("creates every missing level in order", async () => {
    const vault = vaultOf();
    await expect(ensureParentFolders(asVault(vault), "a/b/c/note.md")).resolves.toEqual({ ok: true, created: ["a", "a/b", "a/b/c"] });
    expect([...vault.folderSet].sort()).toEqual(["a", "a/b", "a/b/c"]);
  });

  it("reuses folders that already exist", async () => {
    const vault = vaultOf([], ["a", "a/b"]);
    await expect(ensureParentFolders(asVault(vault), "a/b/note.md")).resolves.toEqual({ ok: true, created: [] });
  });

  it("creates only the missing suffix", async () => {
    const vault = vaultOf([], ["a"]);
    await expect(ensureParentFolders(asVault(vault), "a/b/note.md")).resolves.toEqual({ ok: true, created: ["a/b"] });
  });

  it("refuses to touch a file that occupies a parent path", async () => {
    const vault = vaultOf(["a/b"]);
    await expect(ensureParentFolders(asVault(vault), "a/b/note.md")).resolves.toMatchObject({ ok: false, reason: "parent-path-is-file", path: "a/b" });
    // Nothing is created, and the occupying file is untouched.
    expect([...vault.folderSet]).toEqual(["a"]);
    expect([...vault.fileSet]).toEqual(["a/b"]);
  });

  it("falls back to adapter.mkdir when createFolder fails", async () => {
    const vault = vaultOf();
    const fallback = { ...vault, createFolder: async () => { throw new Error("EACCES: permission denied"); } };
    await expect(ensureParentFolders(asVault(fallback), "a/b/note.md")).resolves.toEqual({ ok: true, created: ["a", "a/b"] });
    expect([...vault.folderSet].sort()).toEqual(["a", "a/b"]);
  });

  it("reports a folder-create failure only when both Vault and adapter creation fail", async () => {
    const vault = { ...vaultOf(), createFolder: async () => { throw new Error("EACCES: permission denied"); }, adapter: { exists: async () => false, mkdir: async () => { throw new Error("EACCES: permission denied"); } } };
    await expect(ensureParentFolders(asVault(vault), "a/note.md")).resolves.toMatchObject({ ok: false, reason: "folder-create-failed", path: "a" });
  });

  it("tolerates a concurrent writer that created the folder first", async () => {
    const vault = vaultOf();
    const raced = {
      ...vault,
      createFolder: async (path: string) => {
        vault.folderSet.add(path);
        throw new Error("already exists");
      },
    };
    await expect(ensureParentFolders(asVault(raced), "a/note.md")).resolves.toEqual({ ok: true, created: [] });
  });

  it("does not roll back folders it already created when a later level fails", async () => {
    const vault = vaultOf();
    const partial = {
      ...vault,
      createFolder: async (path: string) => {
        if (path === "a/b") throw new Error("EACCES: permission denied");
        vault.folderSet.add(path);
        return { path };
      },
      adapter: {
        exists: async (path: string) => vault.folderSet.has(path) || vault.fileSet.has(path),
        mkdir: async (path: string) => { if (path === "a/b") throw new Error("EACCES: permission denied"); vault.folderSet.add(path); },
      },
    };
    await expect(ensureParentFolders(asVault(partial), "a/b/note.md")).resolves.toMatchObject({ ok: false, reason: "folder-create-failed", path: "a/b" });
    // "a" stays behind on purpose: leaving an empty folder is safer than deleting it.
    expect([...vault.folderSet]).toEqual(["a"]);
  });
});
