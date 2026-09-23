import { shortConflictId } from "../conflict/identity";
import type { ConflictRecord, ResolutionIntentType } from "../conflict/types";
import { threeWayMerge } from "../sync/merge";
import { fromLines, toLines, type DecodedText } from "../sync/text";

/**
 * Turns a stored conflict into something a person can decide about.
 *
 * This is presentation only: it reads the record's snapshot and runs the *existing* merge engine to
 * recover the structural hunks it already computes, then describes them. It never re-decides whether
 * something is a conflict, never writes, and never changes what a resolution means.
 *
 * The governing rule is that the default view must not require the reader to understand Git:
 *
 * - the two sides are named by *role* ("This device", "Other version"), not by transport direction;
 * - only the disagreeing region is shown, with the shared lines kept as quiet context;
 * - when both sides merely added text at the same spot, the merge engine's own hunk says so, and the
 *   offered action becomes the one a person would actually pick — keep both;
 * - raw texts, ETags, conflict ids and `<<<<<<<` markers exist, but only behind "Technical details".
 */

export const THIS_DEVICE_LABEL = "This device";
export const OTHER_VERSION_LABEL = "Other version";

/** What the modal can ask the user to choose. Only `edit` is not itself an intent. */
export type ConflictActionId = "keep-both" | "keep-current" | "keep-other" | "edit" | "accept-remote-delete" | "accept-local-delete";

export interface ConflictActionView {
  id: ConflictActionId;
  /** The intent this action proposes; absent for `edit`, which opens the editor first. */
  intent?: ResolutionIntentType;
  label: string;
  /** Exactly one action is primary. */
  primary: boolean;
}

export interface ConflictHunkView {
  index: number;
  total: number;
  /** Section heading, e.g. "Both versions added content here:". */
  title: string;
  /** Column headings, already phrased for the kind of change. */
  currentHeading: string;
  otherHeading: string;
  /** The disagreeing region as the common ancestor had it. Classification detail, not a panel. */
  base: string;
  /** A few shared lines just before the change, so the region can be located in the file. */
  contextBefore: string;
  /** A couple of shared lines just after it. */
  contextAfter: string;
  current: string;
  other: string;
  /** Both sides only inserted here, so keeping both is a plain concatenation. */
  insertBoth: boolean;
}

export interface ConflictView {
  path: string;
  /** "1 change needs your attention". */
  headline: string;
  currentLabel: string;
  otherLabel: string;
  hunks: ConflictHunkView[];
  /** The whole file as it would be if both sides were kept. Absent when that is not a real option. */
  keepBothText?: string;
  /** What the manual editor opens with. Never contains conflict markers. */
  resultText: string;
  actions: ConflictActionView[];
  /** An honest explanation when a structural comparison was not possible. */
  notice?: string;
  /** Everything technical, rendered collapsed. */
  technical: Array<{ label: string; value: string }>;
}

const KEEP_CURRENT: ConflictActionView = { id: "keep-current", intent: "keep-local", label: "Keep current device", primary: false };
const KEEP_OTHER: ConflictActionView = { id: "keep-other", intent: "keep-remote", label: "Keep other version", primary: false };
const EDIT: ConflictActionView = { id: "edit", label: "Edit manually", primary: false };

/** At most one action is primary, and it is the one that loses nothing. */
function primaryOf(actions: ConflictActionView[], preferred: ConflictActionId): ConflictActionView[] {
  const chosen = actions.find((action) => action.id === preferred) ?? actions[0];
  return actions.map((action) => ({ ...action, primary: action === chosen }));
}

function asDecoded(text: string): DecodedText {
  return { text, shape: { bom: false, eol: "lf", trailingNewline: text.endsWith("\n") } };
}

/**
 * The whole file with both sides kept, computed by trimming the lines the two sides share.
 *
 * The shared head and tail are emitted once and each side's own middle is emitted in full, so a pair of
 * pure additions reads in the order the user made them rather than interleaved.
 */
export function keepBothText(local: string, remote: string): string {
  const left = toLines(local);
  const right = toLines(remote);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  const limit = Math.min(left.length, right.length) - prefix;
  while (suffix < limit && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
  return fromLines([
    ...left.slice(0, prefix),
    ...left.slice(prefix, left.length - suffix),
    ...right.slice(prefix, right.length - suffix),
    ...left.slice(left.length - suffix),
  ]);
}

/** How many shared lines of context are shown around a conflicting region. */
const CONTEXT_BEFORE_LINES = 3;
const CONTEXT_AFTER_LINES = 2;

/**
 * The lines the two sides share immediately around their disagreement, trimmed to a few.
 *
 * A conflict block is only useful if the reader can see where in the file it sits, but the spec is
 * explicit that the shared text must stay quiet, so only the lines touching the change are kept.
 */
function sharedContext(local: string, remote: string): { before: string; after: string } {
  const left = toLines(local);
  const right = toLines(remote);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  const limit = Math.min(left.length, right.length) - prefix;
  while (suffix < limit && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
  return {
    before: fromLines(left.slice(Math.max(0, prefix - CONTEXT_BEFORE_LINES), prefix)),
    after: fromLines(left.slice(left.length - suffix, left.length - suffix + CONTEXT_AFTER_LINES)),
  };
}

/**
 * Whether both sides only **added** text on top of the same ancestor content.
 *
 * The test is on the text, not on the line model, because the line model is stricter than a person:
 * a last line that gains its terminating newline (`windows` → `windows\n`) is reported by diff3 as a
 * *replacement* of that line, while both users experienced it as appending. Asking "does each side
 * begin with the ancestor's own text and continue past it" answers the question the user is really
 * asking, so the appended case still gets its "keep both" offer.
 */
function addedOnBothSides(base: string, current: string, other: string): boolean {
  return current.length > base.length && other.length > base.length && current.startsWith(base) && other.startsWith(base);
}

function technicalDetails(record: ConflictRecord): Array<{ label: string; value: string }> {  const entries: Array<{ label: string; value: string }> = [
    { label: "Detected", value: new Date(record.detectedAt).toLocaleString() },
    { label: "Conflict ID", value: shortConflictId(record.conflictId) },
    { label: "Remote ETag", value: record.observedRemoteETag ? shortConflictId(record.observedRemoteETag) : "unknown" },
    { label: "Auto merge", value: record.autoMergeStatus },
  ];
  if (record.reason) entries.push({ label: "Reason", value: record.reason });
  if (record.observedRemoteDeletion) entries.push({ label: "Remote state", value: `logically deleted (${shortConflictId(record.observedRemoteDeletion.deletedRemoteETag)})` });
  entries.push({ label: "Base (common ancestor)", value: record.snapshot.baseAvailable ? (record.snapshot.base ?? "") : "not recorded" });
  entries.push({ label: "Raw current device", value: record.snapshot.local ?? "" });
  entries.push({ label: "Raw other version", value: record.snapshot.remote ?? "" });
  if (record.snapshot.draft !== undefined) entries.push({ label: "Raw merge draft", value: record.snapshot.draft });
  return entries;
}

/** Presentation for a stored conflict. Pure: same record in, same view out. */
export function presentConflict(record: ConflictRecord): ConflictView {
  const technical = technicalDetails(record);
  const { base, local, remote } = record.snapshot;
  const common = { path: record.path, currentLabel: THIS_DEVICE_LABEL, otherLabel: OTHER_VERSION_LABEL, technical };

  // A deletion conflict is semantic, not textual: it has no region to compare, and "keep both" would be
  // meaningless. Its decisions stay the version-bound ones the executor implements.
  if (record.observedRemoteDeletion) {
    return {
      ...common,
      headline: "1 change needs your attention",
      hunks: [],
      resultText: local ?? "",
      notice: "The other device deleted this file, while this device has changes to it.",
      actions: primaryOf([
        { id: "keep-current", intent: "keep-local", label: "Keep this device's file", primary: false },
        { id: "accept-remote-delete", intent: "accept-remote-delete", label: "Accept the deletion", primary: false },
      ], "keep-current"),
    };
  }
  if (!record.observedLocal) {
    return {
      ...common,
      headline: "1 change needs your attention",
      hunks: [],
      resultText: remote ?? "",
      notice: "This device deleted the file, while the other version has changes to it.",
      actions: primaryOf([
        { id: "keep-other", intent: "keep-remote", label: "Restore the other version", primary: false },
        { id: "accept-local-delete", intent: "accept-local-delete", label: "Accept the deletion", primary: false },
      ], "keep-other"),
    };
  }

  if (base === undefined || local === undefined || remote === undefined) {
    // No three-way comparison is possible, so the honest view is the two sides plus a manual decision.
    return {
      ...common,
      headline: "1 change needs your attention",
      hunks: [],
      resultText: keepBothText(local ?? "", remote ?? ""),
      notice: record.snapshot.baseAvailable
        ? "These two versions could not be compared line by line."
        : "The common ancestor of these two versions was not recorded, so they cannot be merged automatically.",
      actions: primaryOf([KEEP_CURRENT, KEEP_OTHER, EDIT], "edit"),
    };
  }

  const both = keepBothText(local, remote);
  const merge = threeWayMerge(asDecoded(base), asDecoded(local), asDecoded(remote));

  if (merge.status !== "conflict") {
    // The snapshot no longer disagrees (or could not be decoded). One side is already the answer.
    return {
      ...common,
      headline: "1 change needs your attention",
      hunks: [],
      resultText: merge.status === "clean" ? merge.text : both,
      notice: merge.status === "clean" ? "The two versions no longer disagree about any line." : "These two versions could not be compared line by line.",
      actions: primaryOf([KEEP_CURRENT, KEEP_OTHER, EDIT], "edit"),
    };
  }

  const total = merge.hunks.length;
  const context = sharedContext(local, remote);
  const hunks: ConflictHunkView[] = merge.hunks.map((hunk, index) => {
    const insertBoth = addedOnBothSides(hunk.base, hunk.local, hunk.remote);
    return {
      index, total, base: hunk.base, current: hunk.local, other: hunk.remote, insertBoth,
      contextBefore: context.before, contextAfter: context.after,
      title: insertBoth ? (total === 1 ? "Both versions added content here:" : `Change ${index + 1} of ${total}: both versions added content here`) : "Both versions changed this part:",
      currentHeading: insertBoth ? "This device added" : "This device has",
      otherHeading: insertBoth ? "Other version added" : "Other version has",
    };
  });

  // "Keep both" is only honest when every disagreement is an addition on both sides. A replaced or
  // deleted region has no meaningful concatenation, so it is not offered there.
  const canKeepBoth = hunks.every((hunk) => hunk.insertBoth);
  const actions = canKeepBoth
    ? primaryOf([{ id: "keep-both", intent: "merged", label: "Keep both", primary: false }, KEEP_CURRENT, KEEP_OTHER, EDIT], "keep-both")
    : primaryOf([KEEP_CURRENT, KEEP_OTHER, EDIT], "edit");

  return {
    ...common,
    headline: total === 1 ? "1 change needs your attention" : `${total} changes need your attention`,
    hunks,
    keepBothText: canKeepBoth ? both : undefined,
    resultText: both,
    actions,
  };
}
