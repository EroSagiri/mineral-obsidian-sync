import { diff3Merge } from "node-diff3";
import { fromLines, toLines, type DecodedText, type TextShape, decodeText, encodeText, preferredShape } from "./text";

/**
 * True three-way merge over the merge-base snapshot.
 *
 * `node-diff3` is the only merge dependency: MIT, zero dependencies, and it ships a browser build
 * with no Node builtins, which matters because this code runs inside Obsidian on desktop and in the
 * Android WebView. It provides real diff3 regions and — importantly for us — a machine-readable
 * `ok` / `conflict` split per region, so "clean merge" is decided by the algorithm rather than by
 * inspecting rendered conflict markers.
 *
 * This module never touches the Vault, R2, or storage. It takes three decoded texts and returns a
 * verdict.
 */

export type MergeUnavailableReason = "base-unavailable" | "unsupported" | "too-large" | "decode-failed";

export interface MergeConflictHunk {
  /** Local side of the overlapping region, ready to render between conflict markers. */
  local: string;
  /** The region as it was in the merge base. */
  base: string;
  /** Remote side of the overlapping region. */
  remote: string;
}

export type ThreeWayMergeResult =
  | { status: "clean"; text: string; shape: TextShape; bytes: Uint8Array }
  | { status: "conflict"; hunks: MergeConflictHunk[]; draft: string; shape: TextShape }
  | { status: "unavailable"; reason: MergeUnavailableReason };

/**
 * Merges three decoded texts. A genuine three-way merge needs all three inputs; there is deliberately
 * no two-way fallback, because guessing a base from local-versus-remote is exactly the unsafe
 * shortcut this feature exists to avoid.
 */
export function threeWayMerge(base: DecodedText, local: DecodedText, remote: DecodedText): ThreeWayMergeResult {
  const shape = preferredShape(local.shape, remote.shape, base.shape);
  // All three sides are compared in the canonical LF line model, so a pure line-ending or BOM
  // difference between the copies cannot be reported as a content conflict.
  const regions = diff3Merge(toLines(local.text), toLines(base.text), toLines(remote.text), { excludeFalseConflicts: true, stringSeparator: false } as never) as MergeRegion[];

  const merged: string[] = [];
  const hunks: MergeConflictHunk[] = [];
  for (const region of regions) {
    if (region.ok) { merged.push(...region.ok); continue; }
    const sides = region.conflict;
    if (!sides) continue;
    hunks.push({ local: fromLines(sides.a), base: fromLines(sides.o), remote: fromLines(sides.b) });
    // The draft keeps both sides with explicit markers. It exists only so the UI has something to
    // start from; it is never written anywhere unless the user applies it.
    merged.push(`<<<<<<< LOCAL\n`, ...sides.a, `=======\n`, ...sides.b, `>>>>>>> REMOTE\n`);
  }

  const text = fromLines(merged);
  if (hunks.length) return { status: "conflict", hunks, draft: encodeDraft(text, shape), shape };
  return { status: "clean", text, shape, bytes: encodeText(text, shape) };
}

interface MergeRegion { ok?: string[]; conflict?: { a: string[]; o: string[]; b: string[] } }

/** The draft is plain UTF-8 with LF; it is a UI artifact, not a file encoding decision. */
function encodeDraft(text: string, shape: TextShape): string {
  if (!shape.trailingNewline && text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/** Convenience for callers that already hold bytes. */
export function mergeBytes(baseBytes: Uint8Array, localBytes: Uint8Array, remoteBytes: Uint8Array): ThreeWayMergeResult {
  const base = decodeText(baseBytes), local = decodeText(localBytes), remote = decodeText(remoteBytes);
  if (!base || !local || !remote) return { status: "unavailable", reason: "decode-failed" };
  return threeWayMerge(base, local, remote);
}
