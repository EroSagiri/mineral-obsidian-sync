import type { Vault } from "obsidian";

/**
 * Creates the missing parent folders of a Vault-relative file path, one level at a time.
 *
 * Verified behaviour that shaped this helper (real Obsidian Vault, 2026-09-21):
 *
 * - `Vault.createBinary` does **not** create missing parent folders; it fails with `ENOENT`.
 * - `Vault.createFolder` is **not** recursive, so every level is created explicitly.
 * - A Vault path occupied by a *file* is never touched: the write fails instead of trying to
 *   turn it into a folder or replacing it.
 * - Created folders are deliberately **not** rolled back when a later step fails. Leaving an
 *   empty folder is far safer than introducing a second, concurrent delete path; the next
 *   reconcile simply retries the file.
 */

export type EnsureParentFoldersFailure = "parent-path-is-file" | "folder-create-failed";

export type EnsureParentFoldersResult =
  | { ok: true; created: string[] }
  | { ok: false; reason: EnsureParentFoldersFailure; path: string; error: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 180) : "unknown error";
}

/** Resolved as a file (never as a folder). */
function fileAt(vault: Vault, path: string): boolean {
  return vault.getFileByPath(path) !== null;
}

/** Resolved as any Vault entry, folder or file. */
function occupied(vault: Vault, path: string): boolean {
  return fileAt(vault, path) || vault.getAbstractFileByPath(path) !== null;
}

function parentSegments(filePath: string): string[] {
  const segments = filePath.split("/").filter((segment) => segment.length > 0);
  segments.pop();
  return segments;
}

export async function ensureParentFolders(vault: Vault, filePath: string): Promise<EnsureParentFoldersResult> {
  const created: string[] = [];
  let current = "";

  for (const segment of parentSegments(filePath)) {
    current = current ? `${current}/${segment}` : segment;

    if (fileAt(vault, current)) return { ok: false, reason: "parent-path-is-file", path: current, error: `Vault path "${current}" is a file, not a folder` };
    if (occupied(vault, current)) continue;

    try {
      await vault.createFolder(current);
    } catch (error) {
      // Another writer may have won the race between the check and the create.
      if (fileAt(vault, current)) return { ok: false, reason: "parent-path-is-file", path: current, error: `Vault path "${current}" is a file, not a folder` };
      if (!occupied(vault, current)) return { ok: false, reason: "folder-create-failed", path: current, error: `could not create the Vault folder "${current}": ${errorText(error)}` };
      continue;
    }
    created.push(current);
  }

  return { ok: true, created };
}
