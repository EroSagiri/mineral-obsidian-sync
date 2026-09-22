import type { LocalEntry, PreviousEntry, RemoteDeletionIdentity, RemoteEntry } from "../sync/types";
import { CONFLICT_PROTOCOL_VERSION, type BaselineIdentity } from "./types";

/**
 * Deterministic conflict identity.
 *
 * A conflict is not "this path is conflicted" — it is "these two versions of this path, measured
 * against this baseline, disagree". Binding the identity to all four inputs is what makes a stale
 * user decision impossible to apply to fresh content:
 *
 * - if the local file changes, a new conflict id appears and an old resolution no longer matches;
 * - if the remote ETag advances, likewise;
 * - if the baseline moves (a previous successful sync), likewise.
 *
 * The id is a SHA-256 over a length-prefixed, versioned encoding of those inputs, so no combination
 * of values can be confused with another.
 */

function segment(value: string): string { return `${value.length}:${value}`; }

function localIdentity(entry: LocalEntry | undefined): string {
  return entry ? `${entry.size}:${entry.mtime}` : "absent";
}

function baselineIdentity(entry: PreviousEntry | undefined): string {
  if (!entry) return "absent";
  return [localIdentity(entry.local ? { key: entry.key, size: entry.local.size, mtime: entry.local.mtime } : undefined), entry.remote?.etag ?? "no-etag", entry.remote?.size ?? "no-size"].join("|");
}

export function canonicalConflictInput(input: {
  channel: string;
  path: string;
  previous?: PreviousEntry;
  observedLocal?: LocalEntry;
  observedRemote?: RemoteEntry;
  observedRemoteDeletion?: RemoteDeletionIdentity;
}): string {
  return [
    `v${CONFLICT_PROTOCOL_VERSION}`,
    segment(input.channel),
    segment(input.path),
    segment(baselineIdentity(input.previous)),
    segment(localIdentity(input.observedLocal)),
    segment(input.observedRemoteDeletion ? `deleted:${input.observedRemoteDeletion.path}:${input.observedRemoteDeletion.deletedRemoteETag}:${input.observedRemoteDeletion.createdAt}:${input.observedRemoteDeletion.objectPresent}` : input.observedRemote?.etag ?? "no-etag"),
  ].join(":");
}

export async function conflictIdFor(input: {
  channel: string;
  path: string;
  previous?: PreviousEntry;
  observedLocal?: LocalEntry;
  observedRemote?: RemoteEntry;
  observedRemoteDeletion?: RemoteDeletionIdentity;
}): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalConflictInput(input)));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // A plain ArrayBuffer view keeps WebCrypto happy across the DOM and Cloudflare type definitions.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function baselineOf(previous: PreviousEntry): BaselineIdentity | undefined {
  if (!previous.local) return undefined;
  return { localVersion: { key: previous.key, size: previous.local.size, mtime: previous.local.mtime }, remoteETag: previous.remote?.etag };
}

/** A snapshot is usable only while it still describes the exact baseline in force right now. */
export function baselineMatches(identity: BaselineIdentity, previous: PreviousEntry | undefined): boolean {
  if (!previous) return false;
  if (!previous.local) return false;
  if (identity.localVersion.size !== previous.local.size || identity.localVersion.mtime !== previous.local.mtime) return false;
  return (identity.remoteETag ?? undefined) === (previous.remote?.etag ?? undefined);
}

/** Short, non-reversible form for logs and the status bar; never the full id, never content. */
export function shortConflictId(conflictId: string): string { return conflictId.slice(0, 8); }

/**
 * A user-edited merged result is stored as normalized text (UTF-8, LF, no BOM) and re-encoded by the
 * executor. The manual editor is a plain text surface with no byte-level view, so claiming to
 * preserve a BOM or CRLF that the user cannot see would be guesswork; the file is written in the
 * canonical form instead, and the docs say so.
 */
export const MANUAL_MERGE_ENCODING = { bom: false, eol: "lf", trailingNewline: true } as const;

export async function mergedContentOf(text: string): Promise<{ content: string; sha256: string; encoding: { bom: boolean; eol: "lf" | "crlf" | "mixed"; trailingNewline: boolean } }> {
  const bytes = new TextEncoder().encode(text);
  return { content: text, sha256: await sha256Hex(bytes), encoding: { ...MANUAL_MERGE_ENCODING } };
}
