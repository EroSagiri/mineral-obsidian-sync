import { shortConflictId } from "../conflict/identity";
import { isAutoResolved, type ConflictRecord } from "../conflict/types";
import { threeWayMerge, type MergeConflictHunk } from "../sync/merge";
import { fromLines, significantText, toLines, type DecodedText } from "../sync/text";

/**
 * What the resolver is allowed to say, decided once, in a pure function.
 *
 * The information architecture this serves is deliberate:
 *
 * 1. **the suggested result** — the only question the first screen asks is "is this the result you
 *    want?";
 * 2. **the differences** — only reached on request, and only here are two sides shown side by side;
 * 3. **technical details** — collapsed, and never needed to finish the task.
 *
 * Two rules keep it honest. First, the UI never decides a merge: a suggested result exists only when
 * something provable produced one — the coordinator's own clean auto-merge, the engine's own clean
 * result, or an addition on both sides that is safe to concatenate. When none of those holds, the view
 * says so and asks the user to write the result, rather than guessing one. Second, a difference is only
 * shown when it is a *content* difference: line endings, a trailing newline and end-of-line whitespace
 * are presentation noise, filtered here for display while the untouched text stays in technical details.
 */

export type ResultSource = "auto-merge" | "engine" | "combination";

/** How a disagreeing region actually relates to its ancestors. */
export type DifferenceKind =
  /** Both sides changed this region to different content. */
  | "both-changed"
  /** Both sides only added lines onto the same ancestor content, so both can be kept. */
  | "both-added"
  /** Only this device changed it; the other side still matches the ancestor here. */
  | "current-only"
  /** Only the other version changed it. */
  | "other-only"
  /** The two sides are the same apart from line endings, trailing whitespace or a final newline. */
  | "formatting-only";

export interface DifferenceView {
  index: number;
  total: number;
  kind: DifferenceKind;
  /** Neutral section title: "added" is only claimed when the classification proves it. */
  title: string;
  contextBefore: string;
  contextAfter: string;
  current: string;
  other: string;
  currentHeading: string;
  otherHeading: string;
  /** One line explaining a one-sided or formatting-only difference. */
  note?: string;
}

export interface TechnicalEntry { label: string; value: string }

/** The pages the resolver can show. Three kinds, one per shape of problem. */
export type ConflictPresentation =
  | {
      kind: "suggested";
      path: string;
      summary: string;
      /** Section label, e.g. "Suggested result". */
      label: string;
      suggestedText: string;
      source: ResultSource;
      differences: DifferenceView[];
      /** True when every difference is presentation noise, so the differences page says so. */
      differencesAreNoise: boolean;
      technical: TechnicalEntry[];
    }
  | {
      kind: "manual";
      path: string;
      summary: string;
      /** What the editor opens with; never conflict markers. */
      draftText: string;
      differences: DifferenceView[];
      differencesAreNoise: boolean;
      /** Why no result could be suggested, in the user's terms. */
      notice?: string;
      technical: TechnicalEntry[];
    }
  | {
      kind: "delete-vs-modify";
      path: string;
      summary: string;
      explanation: string;
      modifiedText: string;
      /** Which side no longer has the note. */
      deletedSide: "current" | "other";
      technical: TechnicalEntry[];
    };

export const THIS_DEVICE_LABEL = "This device";
export const OTHER_VERSION_LABEL = "Other version";
export const SUGGESTED_LABEL = "Suggested result";
export const MANUAL_SUMMARY = "This change could not be merged automatically.";

/** How many shared lines of context a difference block shows. */
const CONTEXT_BEFORE_LINES = 3;
const CONTEXT_AFTER_LINES = 2;

/**
 * The normal form used *only* to decide what is worth showing.
 *
 * Line endings, a byte-order mark, trailing spaces on a line and trailing newlines are how a file is
 * stored, not what the user wrote differently. Comparing in this form is what stops "the other side
 * added a newline" from ever reaching the screen. The original text is never rewritten by this — it is
 * still what technical details shows and what a resolution applies. It lives in `sync/text` because the
 * divergence policy applies exactly the same rule when deciding what may be merged.
 */
export { significantText } from "../sync/text";

/** Whether both sides only added text on top of the ancestor's own content. */
function addedOnBothSides(base: string, current: string, other: string): boolean {
  return current.length > base.length && other.length > base.length && current.startsWith(base) && other.startsWith(base);
}

function classify(hunk: MergeConflictHunk): DifferenceKind {
  const base = significantText(hunk.base);
  const current = significantText(hunk.local);
  const other = significantText(hunk.remote);
  if (current === other) return "formatting-only";
  if (current === base) return "other-only";
  if (other === base) return "current-only";
  return addedOnBothSides(hunk.base, hunk.local, hunk.remote) ? "both-added" : "both-changed";
}

/** The lines the two sides share around their disagreement, trimmed to a few. */
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
 * Both sides kept, for the one case where that is provably safe: each side begins with the ancestor's
 * own text and continues past it, so neither replaced anything the other needs.
 *
 * The shared head and tail are emitted once and each side's own middle in full, which is why a pair of
 * pure additions reads in the order the user made them.
 */
export function combineAdditions(local: string, remote: string): string {
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

function asDecoded(text: string): DecodedText {
  return { text, shape: { bom: false, eol: "lf", trailingNewline: text.endsWith("\n") } };
}

function differenceViews(hunks: MergeConflictHunk[], local: string, remote: string): DifferenceView[] {
  const context = sharedContext(local, remote);
  return hunks.map((hunk, index) => {
    const kind = classify(hunk);
    const titles: Record<DifferenceKind, string> = {
      "both-added": "Both versions added content here",
      "both-changed": "Both versions changed this area",
      "current-only": "Only this device changed this area",
      "other-only": "Only the other version changed this area",
      "formatting-only": "These versions differ here only in formatting",
    };
    const notes: Partial<Record<DifferenceKind, string>> = {
      "current-only": "The other version still matches the common ancestor here.",
      "other-only": "This device still matches the common ancestor here.",
      "formatting-only": "The text is the same apart from line endings, trailing spaces or the final newline.",
    };
    const current = kind === "other-only" || kind === "formatting-only" ? "" : hunk.local;
    const other = kind === "current-only" || kind === "formatting-only" ? "" : hunk.remote;
    return {
      index, total: hunks.length, kind,
      title: titles[kind],
      current, other,
      currentHeading: kind === "both-added" ? "This device added" : "This device has",
      otherHeading: kind === "both-added" ? "Other version added" : "Other version has",
      contextBefore: context.before, contextAfter: context.after,
      note: notes[kind],
    };
  });
}

/** The result the resolver is willing to stand behind, with the evidence for it. */
function suggestedFor(record: ConflictRecord, base: string, local: string, remote: string): { text: string; source: ResultSource } | undefined {
  // 1. The divergence policy's own verdict: its draft *is* the text it settled on, whether that was a
  //    non-colliding merge or a handoff whose two additions it combined.
  if (isAutoResolved(record.autoMergeStatus) && record.snapshot.draft !== undefined) return { text: record.snapshot.draft, source: record.autoMergeStatus === "handoff" ? "combination" : "auto-merge" };
  // 2. The engine's own answer, recomputed from the snapshot we are about to show.
  const merge = threeWayMerge(asDecoded(base), asDecoded(local), asDecoded(remote));
  if (merge.status === "clean") return { text: merge.text, source: "engine" };
  if (merge.status !== "conflict" || merge.hunks.length !== 1) return undefined;
  // 3. A single region that is provably safe to settle without asking. Anything else is the user's call.
  const kind = classify(merge.hunks[0]!);
  if (kind === "current-only" || kind === "formatting-only") return { text: local, source: "combination" };
  if (kind === "other-only") return { text: remote, source: "combination" };
  if (kind === "both-added") return { text: combineAdditions(local, remote), source: "combination" };
  return undefined;
}

/**
 * Everything the resolver is allowed to display, for one stored conflict.
 *
 * Pure: the same record always produces the same pages, and nothing here writes, decides, or reaches
 * for a transport.
 */
export function presentConflict(record: ConflictRecord): ConflictPresentation {
  const technical = technicalDetails(record);
  const { base, local, remote } = record.snapshot;
  const summary = "1 change needs your attention";

  if (record.observedRemoteDeletion) {
    return {
      kind: "delete-vs-modify", path: record.path, summary,
      explanation: "One device deleted this note, while another device kept editing it.",
      modifiedText: local ?? "", deletedSide: "other", technical,
    };
  }
  if (!record.observedLocal) {
    return {
      kind: "delete-vs-modify", path: record.path, summary,
      explanation: "This device deleted this note, while the other version kept editing it.",
      modifiedText: remote ?? "", deletedSide: "current", technical,
    };
  }

  const comparable = base !== undefined && local !== undefined && remote !== undefined;
  const merge = comparable ? threeWayMerge(asDecoded(base), asDecoded(local), asDecoded(remote)) : undefined;
  const hunks = merge?.status === "conflict" ? merge.hunks : [];
  const differences = differenceViews(hunks, local ?? "", remote ?? "");
  const differencesAreNoise = differences.every((difference) => difference.kind === "formatting-only");
  const suggested = comparable ? suggestedFor(record, base, local, remote) : undefined;

  if (suggested) {
    return {
      kind: "suggested", path: record.path, summary, label: SUGGESTED_LABEL,
      suggestedText: suggested.text, source: suggested.source,
      differences, differencesAreNoise, technical,
    };
  }
  return {
    kind: "manual", path: record.path, summary,
    draftText: local ?? "",
    differences, differencesAreNoise,
    notice: comparable
      ? "The two versions changed the same text in different ways, so no result could be prepared."
      : "The common ancestor of these two versions was not recorded, so no result could be prepared.",
    technical,
  };
}

function technicalDetails(record: ConflictRecord): TechnicalEntry[] {
  const entries: TechnicalEntry[] = [
    { label: "Detected", value: new Date(record.detectedAt).toLocaleString() },
    { label: "Conflict ID", value: shortConflictId(record.conflictId) },
    { label: "Remote ETag", value: record.observedRemoteETag ? shortConflictId(record.observedRemoteETag) : "unknown" },
    { label: "Auto merge", value: record.autoMergeStatus },
  ];
  if (record.reason) entries.push({ label: "Reason", value: record.reason });
  if (record.observedRemoteDeletion) entries.push({ label: "Remote state", value: `logically deleted (${shortConflictId(record.observedRemoteDeletion.deletedRemoteETag)})` });
  entries.push({ label: "Base", value: record.snapshot.baseAvailable ? (record.snapshot.base ?? "") : "not recorded" });
  entries.push({ label: "Raw current device", value: record.snapshot.local ?? "" });
  entries.push({ label: "Raw other version", value: record.snapshot.remote ?? "" });
  if (record.snapshot.draft !== undefined) entries.push({ label: "Raw merged draft", value: record.snapshot.draft });
  return entries;
}
