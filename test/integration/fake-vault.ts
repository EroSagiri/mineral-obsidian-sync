import type { PreviousEntry } from "../../src/sync/types";
import type { StateStore } from "../../src/state/sync-state";

/** In-memory stand-in for the IndexedDB store; real IndexedDB is exercised in Obsidian. */
export function createMemoryStateStore(): StateStore & { entries: Map<string, PreviousEntry> } {
  const entries = new Map<string, PreviousEntry>();
  return {
    entries,
    loadAll: async () => new Map(entries),
    saveVerified: async (verified) => {
      for (const [key, entry] of verified) entries.set(key, entry);
    },
    saveAll: async (next) => {
      entries.clear();
      for (const [key, entry] of next) entries.set(key, entry);
    },
    put: async (entry) => {
      entries.set(entry.key, entry);
    },
  };
}

export interface FakeLocalFile {
  path: string;
  stat: { size: number; mtime: number };
}

export interface FakeVaultOptions {
  /**
   * Mirrors Obsidian refusing to create dot-directories. Defaults to `false` because the
   * preferred design is a hidden scratch root; the harness must survive either behaviour.
   */
  refuseDotFolders?: boolean;
}

export interface FakeVault {
  files: Map<string, { bytes: Uint8Array; mtime: number }>;
  folders: Set<string>;
  getFiles(): FakeLocalFile[];
  getFileByPath(path: string): FakeLocalFile | null;
  getAbstractFileByPath(path: string): FakeLocalFile | { path: string; children: never[] } | null;
  createFolder(path: string): Promise<{ path: string }>;
  createBinary(path: string, bytes: ArrayBuffer): Promise<FakeLocalFile>;
  modifyBinary(file: FakeLocalFile, bytes: ArrayBuffer): Promise<void>;
  readBinary(file: FakeLocalFile): Promise<ArrayBuffer>;
  adapter: {
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    stat(path: string): Promise<{ size: number; mtime: number } | null>;
  };
}

const ROOT = "";

function parentOf(path: string): string {
  const segments = path.split("/");
  segments.pop();
  return segments.join("/");
}

function isHidden(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

/**
 * Minimal Vault stand-in. It deliberately reproduces the real Obsidian behaviours the harness
 * depends on: `createBinary` does **not** create parent folders (it throws ENOENT), and
 * `createFolder` is not recursive.
 */
export function createFakeVault(initial: Record<string, Uint8Array> = {}, options: FakeVaultOptions = {}): FakeVault {
  const files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  const folders = new Set<string>();
  let clock = Date.parse("2026-09-22T00:00:00.000Z");

  const file = (path: string): FakeLocalFile | null => {
    const entry = files.get(path);
    return entry ? { path, stat: { size: entry.bytes.byteLength, mtime: entry.mtime } } : null;
  };
  const folderExists = (path: string): boolean => path === ROOT || folders.has(path);
  const assertWritableFolder = (path: string): void => {
    if (options.refuseDotFolders && isHidden(path)) throw new Error(`EPERM: Obsidian refused to create the hidden path "${path}"`);
    if (!folderExists(parentOf(path))) throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
  };
  const addFolder = (path: string): void => {
    assertWritableFolder(path);
    folders.add(path);
  };

  for (const [path, bytes] of Object.entries(initial)) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) folders.add(segments.slice(0, index).join("/"));
    files.set(path, { bytes, mtime: (clock += 1) });
  }

  return {
    files,
    folders,
    getFiles: () => [...files.keys()].map((path) => file(path)!),
    getFileByPath: (path) => file(path),
    getAbstractFileByPath: (path) => file(path) ?? (folders.has(path) ? { path, children: [] } : null),
    createFolder: async (path) => {
      if (folders.has(path)) throw new Error(`Folder already exists: ${path}`);
      addFolder(path);
      return { path };
    },
    createBinary: async (path, bytes) => {
      if (files.has(path)) throw new Error(`File already exists: ${path}`);
      // The real Obsidian Vault.createBinary does not create parent folders.
      if (!folderExists(parentOf(path))) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      files.set(path, { bytes: new Uint8Array(bytes.slice(0)), mtime: (clock += 1) });
      return file(path)!;
    },
    modifyBinary: async (target, bytes) => {
      if (!files.has(target.path)) throw new Error(`ENOENT: no such file or directory, open '${target.path}'`);
      files.set(target.path, { bytes: new Uint8Array(bytes.slice(0)), mtime: (clock += 1) });
    },
    readBinary: async (target) => {
      const entry = files.get(target.path);
      if (!entry) throw new Error(`ENOENT: no such file or directory, open '${target.path}'`);
      return entry.bytes.slice(0).buffer;
    },
    adapter: {
      exists: async (path) => folderExists(path) || files.has(path),
      mkdir: async (path) => {
        if (folders.has(path)) throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
        addFolder(path);
      },
      stat: async (path) => {
        const entry = files.get(path);
        return entry ? { size: entry.bytes.byteLength, mtime: entry.mtime } : null;
      },
    },
  };
}
