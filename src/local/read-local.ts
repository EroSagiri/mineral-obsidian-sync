import type { Vault } from "obsidian";
import type { LocalEntry } from "../sync/types";

export class LocalFileChangedError extends Error {
  constructor() { super("Local file changed since its metadata scan"); this.name = "LocalFileChangedError"; }
}

function matches(stat: { size: number; mtime: number } | null, expected: LocalEntry): boolean {
  return stat !== null && stat.size === expected.size && stat.mtime === expected.mtime;
}

/** Reads Vault bytes, validating the scan observation both before and after the read. */
export async function readStableLocalBytes(vault: Vault, expected: LocalEntry): Promise<ArrayBuffer> {
  const file = vault.getFileByPath(expected.key);
  if (!file || !matches(await vault.adapter.stat(expected.key), expected)) throw new LocalFileChangedError();
  const bytes = await vault.readBinary(file);
  if (!matches(await vault.adapter.stat(expected.key), expected)) throw new LocalFileChangedError();
  return bytes;
}

/** Reads the newest complete local version when an earlier conditional upload already landed. */
export async function readCurrentStableLocalBytes(vault: Vault, key: string): Promise<{ bytes: ArrayBuffer; version: LocalEntry }> {
  const file = vault.getFileByPath(key);
  const before = await vault.adapter.stat(key);
  if (!file || !before) throw new LocalFileChangedError();
  const version = { key, size: before.size, mtime: before.mtime };
  const bytes = await vault.readBinary(file);
  if (!matches(await vault.adapter.stat(key), version)) throw new LocalFileChangedError();
  return { bytes, version };
}
