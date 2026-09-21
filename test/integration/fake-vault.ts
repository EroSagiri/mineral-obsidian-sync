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

export interface FakeVault {
  files: Map<string, { bytes: Uint8Array; mtime: number }>;
  getFiles(): FakeLocalFile[];
  getFileByPath(path: string): FakeLocalFile | null;
  adapter: { stat(path: string): Promise<{ size: number; mtime: number } | null> };
  readBinary(file: FakeLocalFile): Promise<ArrayBuffer>;
  createBinary(path: string, bytes: ArrayBuffer): Promise<FakeLocalFile>;
  modifyBinary(file: FakeLocalFile, bytes: ArrayBuffer): Promise<void>;
}

/** Minimal Vault stand-in with Obsidian-like stat/read/create/modify semantics. */
export function createFakeVault(initial: Record<string, Uint8Array> = {}): FakeVault {
  const files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  let clock = Date.parse("2026-09-22T00:00:00.000Z");
  for (const [path, bytes] of Object.entries(initial)) files.set(path, { bytes, mtime: (clock += 1) });

  const stat = (path: string): { size: number; mtime: number } | null => {
    const entry = files.get(path);
    return entry ? { size: entry.bytes.byteLength, mtime: entry.mtime } : null;
  };
  const file = (path: string): FakeLocalFile | null => {
    const entry = stat(path);
    return entry ? { path, stat: entry } : null;
  };
  return {
    files,
    getFiles: () => [...files.keys()].map((path) => file(path)!),
    getFileByPath: (path) => file(path),
    adapter: { stat: async (path) => stat(path) },
    readBinary: async (target) => {
      const entry = files.get(target.path);
      if (!entry) throw new Error(`fake Vault file ${target.path} is missing`);
      return entry.bytes.slice(0).buffer;
    },
    createBinary: async (path, bytes) => {
      if (files.has(path)) throw new Error(`fake Vault refused to overwrite ${path}`);
      files.set(path, { bytes: new Uint8Array(bytes.slice(0)), mtime: (clock += 1) });
      return file(path)!;
    },
    modifyBinary: async (target, bytes) => {
      if (!files.has(target.path)) throw new Error(`fake Vault file ${target.path} is missing`);
      files.set(target.path, { bytes: new Uint8Array(bytes.slice(0)), mtime: (clock += 1) });
    },
  };
}
