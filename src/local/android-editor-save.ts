/**
 * The decisions behind the Android editor-save path, kept pure so they can be pinned by tests.
 *
 * Android can keep an edit inside the active MarkdownView instead of the file, and a buffer is
 * invisible to every file-level trigger the sync pipeline has: Vault events, the metadata drift scan,
 * the integrity check and a foreground resume all read the *file*, which by definition has not been
 * written. The plugin therefore has to write the buffer itself, and the two decisions here are what
 * make that reliable:
 *
 * - an owed write is never discarded silently, because dropping it leaves the path blind until the user
 *   happens to type again;
 * - a write that changed nothing is not reported as a local change, because Android reloads a
 *   downloaded file into the editor, and that fires `editor-change` for a buffer that already matches.
 */

/** The version a Vault reports for a path; the two fields every change decision is made from. */
export interface FileStamp { size: number; mtime: number }

/** What a flush attempt should do, given the state of the app and of the path's view. */
export type FlushAction =
  /** A view holds the path and the app can write it: perform the save. */
  | "save"
  /** The buffer is still owed. Keep it and try again on the next visibility change or drift tick. */
  | "retry-later"
  /** No view holds the path any more, so there is no buffer left to write. */
  | "mark-only";

/**
 * `force` is for the moments the WebView is about to stop running — going to the background, or
 * unloading — where a save is worth attempting even though the document already reports itself hidden.
 */
export function flushAction(state: { hidden: boolean; hasView: boolean; force?: boolean }): FlushAction {
  if (state.hidden && !state.force) return "retry-later";
  if (!state.hasView) return "mark-only";
  return "save";
}

/**
 * True when a Vault write actually changed the file.
 *
 * `view.save()` on a clean editor writes nothing, and an unknown stamp is treated as a change so that a
 * read failure can only cost a redundant cycle, never a missed one.
 */
export function writeChangedFile(before: FileStamp | null | undefined, after: FileStamp | null | undefined): boolean {
  if (!before || !after) return true;
  return before.size !== after.size || before.mtime !== after.mtime;
}

/**
 * True when an observed version is the write this plugin itself just performed for that path.
 *
 * It is answered by the version rather than by a time window, so a genuinely newer write — the user
 * typing again, or another plugin touching the file — always keeps its own cycle.
 */
export function isOwnWrite(recorded: FileStamp | undefined, observed: FileStamp | null | undefined): boolean {
  return Boolean(recorded && observed && recorded.size === observed.size && recorded.mtime === observed.mtime);
}
