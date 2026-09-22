import { diffIndices } from "node-diff3";
import { toLines, decodeText, type DecodedText, type TextShape, encodeText, preferredShape } from "./text";

/**
 * True three-way merge over the merge-base snapshot.
 *
 * `node-diff3` is the only merge dependency: MIT, zero dependencies, and it ships a browser build with
 * no Node builtins, which matters because this code runs inside Obsidian on desktop and in the Android
 * WebView. We use its `diffIndices` — a well-tested LCS diff — as the *primitive*, and combine the two
 * sides ourselves rather than calling its `diff3Merge`.
 *
 * ## Why not `diff3Merge` directly
 *
 * Its conflict *regions* are produced by merging hunks, so two edits on adjacent lines land in one
 * region and are reported as overlapping even when they touch different lines. That would turn the
 * spec's own canonical example — local edits line B while remote appends after line C — into a
 * spurious conflict, defeating the point of automatic merging. Combining the two diffs directly makes
 * the question exact: do the two sides touch the *same base line*?
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

/** One side's replacement of `base[start, start+length)` with `replacement`. */
interface Range { start: number; length: number; replacement: string[]; }

/**
 * Extracts the ranges in which `side` differs from `base`, in ascending, non-overlapping order.
 *
 * `diffIndices` reports each hunk as `buffer1 = [start, lengthInBase]`, `buffer2 = [start, lengthInSide]`,
 * and supplies the changed lines themselves in `buffer1Content` / `buffer2Content`. An insertion has
 * `lengthInBase === 0`, so it is treated as touching the base line at its offset — conservative, and
 * the only honest answer when two sides insert different text at the same place.
 */
function rangesOf(base: string[], side: string[]): Range[] {
  void side;
  return (diffIndices(base, side) as Array<{ buffer1: number[]; buffer2: number[]; buffer2Content: string[] }>)
    .map((hunk) => ({ start: hunk.buffer1[0] ?? 0, length: hunk.buffer1[1] ?? 0, replacement: hunk.buffer2Content ?? [] }))
    .sort((left, right) => left.start - right.start);
}

function endOf(range: Range): number { return range.start + range.length; }

/**
 * Two changes collide only when they touch the same base line. This is what keeps an edit to line B
 * and an append after line C independent, instead of letting adjacency imply overlap.
 *
 * A "collision" is not automatically a disagreement: when both sides make the *same* edit to the same
 * span, they agree, and reporting a conflict there would be a false positive.
 */
function collides(left: Range, right: Range): boolean {
  const overlaps = Math.max(left.start, right.start) < Math.min(endOf(left), endOf(right));
  // Two pure insertions at the same offset overlap without consuming a base line — the half-open test
  // above cannot see that, so it is stated explicitly. Different text at one point is a real conflict.
  const bothInsertAtSamePoint = left.length === 0 && right.length === 0 && left.start === right.start;
  if (!overlaps && !bothInsertAtSamePoint) return false;
  return !sameReplacement(left, right);
}

function sameReplacement(left: Range, right: Range): boolean {
  if (left.start !== right.start || left.length !== right.length) return false;
  if (left.replacement.length !== right.replacement.length) return false;
  return left.replacement.every((line, index) => line === right.replacement[index]);
}

type Piece = { start: number; end: number; lines: string[] };

/** Folds one side's ranges into a piece list, resolving a shared boundary insertion in index order. */
function piecesOf(baseLength: number, ranges: Range[]): Piece[] {
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > baseLength) continue;
    if (range.start < cursor) continue;
    if (range.start > cursor) pieces.push({ start: cursor, end: range.start, lines: [] });
    pieces.push({ start: range.start, end: endOf(range), lines: range.replacement });
    cursor = endOf(range);
  }
  if (cursor < baseLength) pieces.push({ start: cursor, end: baseLength, lines: [] });
  return pieces;
}

/**
 * Merges two piece lists that are known not to collide, preserving base order.
 *
 * A stable piece and a changed piece that merely touch at a boundary (an append after line C) are
 * ordered so the append follows the line it was appended to.
 */
function interleave(base: string[], local: Piece[], remote: Piece[]): string[] {
  const output: string[] = [];
  const events = [
    ...local.map((piece) => ({ piece, changed: piece.lines.length > 0 || piece.end > piece.start })),
    ...remote.map((piece) => ({ piece, changed: piece.lines.length > 0 || piece.end > piece.start })),
  ].sort((left, right) => left.piece.start - right.piece.start || right.piece.end - left.piece.end);

  let cursor = 0;
  let lastEmitted: Piece | undefined;
  for (const event of events) {
    // Identical edits can land on exactly the same span from both sides; emitting both would duplicate
    // the text, so an exactly repeated span is emitted once.
    if (lastEmitted && event.piece.start === lastEmitted.start && event.piece.end === lastEmitted.end) continue;
    if (event.piece.end <= cursor) continue;
    // A stable piece (no replacement) never needs emitting: the `base.slice` below already covers it.
    if (event.piece.lines.length === 0) continue;
    output.push(...base.slice(cursor, event.piece.start));
    output.push(...event.piece.lines);
    cursor = event.piece.end;
    lastEmitted = event.piece;
  }
  if (cursor < base.length) output.push(...base.slice(cursor));
  return output;
}

/**
 * The minimal region each side actually changed within the conflicting base span.
 *
 * The base span is the union of every colliding change; within it, each side's contribution is found
 * by trimming the lines it shares with the base from both ends. That yields a hunk showing only what
 * disagrees, rather than dumping both whole files into the conflict view.
 */
function conflictRegion(baseLines: string[], localLines: string[], remoteLines: string[], localRanges: Range[], remoteRanges: Range[]): MergeConflictHunk & { start: number; end: number } {
  const colliding = [...localRanges, ...remoteRanges].filter((range) => [...localRanges, ...remoteRanges].some((other) => other !== range && collides(range, other)));
  const start = Math.min(...colliding.map((range) => range.start));
  const end = Math.max(...colliding.map((range) => Math.min(baseLines.length, endOf(range))));

  const side = (sideLines: string[]): string[] => {
    const region: Piece = { start, end, lines: baseLines.slice(start, end) };
    const rendered = interleave(baseLines, piecesOf(baseLines.length, sideLines === localLines ? localRanges : remoteRanges), [region]);
    // `rendered` is the whole file with this region replaced; trim the shared context away.
    let prefix = 0;
    while (prefix < rendered.length && prefix < start && rendered[prefix] === baseLines[prefix]) prefix++;
    let suffix = 0;
    while (suffix < rendered.length - prefix && suffix < baseLines.length - end && rendered[rendered.length - 1 - suffix] === baseLines[baseLines.length - 1 - suffix]) suffix++;
    return rendered.slice(prefix, rendered.length - suffix);
  };

  return { start, end, base: baseLines.slice(start, end).join(""), local: side(localLines).join(""), remote: side(remoteLines).join("") };
}

/**
 * Merges three decoded texts. A genuine three-way merge needs all three inputs; there is deliberately
 * no two-way fallback, because guessing a base from local-versus-remote is exactly the unsafe shortcut
 * this feature exists to avoid.
 */
export function threeWayMerge(base: DecodedText, local: DecodedText, remote: DecodedText): ThreeWayMergeResult {
  const shape = preferredShape(local.shape, remote.shape, base.shape);
  // All three sides are compared in the canonical LF line model, so a pure line-ending or BOM
  // difference between the copies cannot be reported as a content conflict.
  const baseLines = toLines(base.text);
  const localLines = toLines(local.text);
  const remoteLines = toLines(remote.text);

  const localRanges = rangesOf(baseLines, localLines);
  const remoteRanges = rangesOf(baseLines, remoteLines);

  // Identical edits on both sides are not a disagreement.
  const conflicting = localRanges.some((left) => remoteRanges.some((right) => collides(left, right)));
  if (!conflicting) {
    const text = interleave(baseLines, piecesOf(baseLines.length, localRanges), piecesOf(baseLines.length, remoteRanges)).join("");
    return { status: "clean", text, shape, bytes: encodeText(text, shape) };
  }

  // Present the smallest honest conflict: only the region that genuinely disagrees.
  const region = conflictRegion(baseLines, localLines, remoteLines, localRanges, remoteRanges);
  const hunks: MergeConflictHunk[] = [{ local: region.local, base: region.base, remote: region.remote }];
  // A draft keeps both sides with explicit markers. It exists only so the UI has something to start
  // from; it is never written anywhere unless the user applies it.
  const prefix = baseLines.slice(0, region.start).join("");
  const suffix = baseLines.slice(region.end).join("");
  const draft = `${prefix}<<<<<<< LOCAL\n${region.local}=======\n${region.remote}>>>>>>> REMOTE\n${suffix}`;
  return { status: "conflict", hunks, draft, shape };
}

/** Convenience for callers that already hold bytes. */
export function mergeBytes(baseBytes: Uint8Array, localBytes: Uint8Array, remoteBytes: Uint8Array): ThreeWayMergeResult {
  const base = decodeText(baseBytes), local = decodeText(localBytes), remote = decodeText(remoteBytes);
  if (!base || !local || !remote) return { status: "unavailable", reason: "decode-failed" };
  return threeWayMerge(base, local, remote);
}
