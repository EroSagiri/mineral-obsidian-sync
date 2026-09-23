import { threeWayMerge, type MergeConflictHunk } from "../sync/merge";
import { byteLength, significantText, type DecodedText } from "../sync/text";

/**
 * The divergence policy: which disagreements may be settled without asking anyone.
 *
 * Three levels, deliberately ordered by evidence rather than by convenience:
 *
 * - **clean** — the existing three-way merge already answers it. No time or size condition applies:
 *   if two branches provably do not collide, waiting five days changes nothing.
 * - **handoff** — the two sides disagree, but only by *adding* small amounts of text in one region and
 *   within moments of each other. That is the shape of a device handoff (a laptop closed mid-sentence,
 *   a phone picking it up), and both additions can be kept, so nothing is at stake but order.
 * - **manual** — everything else. A replaced, deleted or large change is a decision about meaning, and
 *   the whole point of this policy is to never guess at meaning.
 *
 * Two properties keep the confident levels honest. Nothing is auto-settled without a *recoverable*
 * ancestor, and the merge is only produced when the ancestor's own text, both sides and the shared
 * head and tail reconstruct each other exactly — which is what proves that the sides differ from the
 * ancestor in one added region and nowhere else. When any check fails the answer is `manual`, not a
 * best effort: this policy is allowed to miss a mergeable case, never to merge a change it cannot
 * account for.
 *
 * Thresholds live here, together, because they are policy rather than mechanism.
 */

/** Two branches written further apart than this are not a handoff. */
export const HANDOFF_MAX_SEPARATION_MS = 30_000;
/** Combined bytes both sides added. Measured as a delta, never as a file size. */
export const HANDOFF_MAX_DELTA_BYTES = 2_048;
/** One disagreeing region is a handoff; more than one is a branch that drifted. */
export const HANDOFF_MAX_HUNKS = 1;
/** Below this, two timestamps are too close to claim which side was written first. */
export const HANDOFF_ORDER_TOLERANCE_MS = 1_000;

export interface ChangeStats {
  insertedBytes: number;
  deletedBytes: number;
  replacedBytes: number;
  hunkCount: number;
}

export interface DivergenceInput {
  /** The recorded ancestor's text, or `undefined` when none is available. */
  base: string | undefined;
  local: string;
  remote: string;
  /** When this device's file was last written, epoch ms. */
  localChangedAt?: number;
  /** When the remote object was last written, epoch ms. */
  remoteChangedAt?: number;
  /** When the baseline both branches grew from was committed, epoch ms. */
  baseSyncedAt?: number;
}

export type DivergenceClass = "clean" | "handoff" | "manual";

export interface DivergenceDecision {
  class: DivergenceClass;
  /** Human-readable evidence, recorded in history and never shown as raw text to the user. */
  reason: string;
  /** The text to write, for `clean` and `handoff`. */
  mergedText?: string;
  stats?: ChangeStats;
  /** What each side added, in bytes, so the two can be judged separately. */
  deltas?: { local: number; remote: number };
  branchSeparationMs?: number;
  branchAgeMs?: number;
  order?: "local-first" | "remote-first" | "deterministic";
}

/** A reconstruction of the file around the disagreeing region. */
interface RegionSplit {
  prefix: string;
  suffix: string;
  /** What each side added on top of the ancestor's own region text. */
  localExtra: string;
  remoteExtra: string;
}

const asDecoded = (text: string): DecodedText => ({ text, shape: { bom: false, eol: "lf", trailingNewline: text.endsWith("\n") } });

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index++;
  return index;
}

function commonSuffixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (count < limit && left[left.length - 1 - count] === right[right.length - 1 - count]) count++;
  return count;
}

/**
 * Splits the file into shared head, disagreeing region and shared tail, and proves the split.
 *
 * The head and tail must be common to the ancestor and *both* sides, and each side must equal
 * `head + its own region text + tail`. Only one split can satisfy all three, and searching from the
 * longest shared head downward finds it. That reconstruction is the proof this policy needs: it says
 * the two sides differ from the ancestor here and nowhere else, which is what makes combining their
 * additions lossless. A replacement fails the `startsWith` test, and an edit elsewhere in the file
 * fails the reconstruction.
 */
function splitRegion(base: string, local: string, remote: string, hunk: MergeConflictHunk): RegionSplit | undefined {
  // Both sides must only extend the ancestor's own region: an addition, never a replacement.
  if (!hunk.local.startsWith(hunk.base) || !hunk.remote.startsWith(hunk.base)) return undefined;
  const longestHead = Math.max(0, Math.min(
    commonPrefixLength(local, remote),
    local.length - hunk.local.length,
    remote.length - hunk.remote.length,
    base.length - hunk.base.length,
  ));
  for (let length = longestHead; length >= 0; length--) {
    const head = local.slice(0, length);
    if (remote.slice(0, length) !== head || base.slice(0, length) !== head) continue;
    const tail = local.slice(length + hunk.local.length);
    if (remote.slice(length + hunk.remote.length) !== tail || base.slice(length + hunk.base.length) !== tail) continue;
    return { prefix: head, suffix: tail, localExtra: hunk.local.slice(hunk.base.length), remoteExtra: hunk.remote.slice(hunk.base.length) };
  }
  return undefined;
}

/**
 * The timestamps this policy is willing to rely on.
 *
 * A missing, zero or non-finite stamp makes the *time* condition unusable, and the policy then falls
 * back to the ordinary conflict path rather than assuming a handoff. The age of the branch is reported
 * for diagnosis but is not a gate: what makes an addition safe is that nothing is lost, not that it
 * happened recently.
 */
function usableTimes(input: DivergenceInput): { localChangedAt: number; remoteChangedAt: number; separationMs: number; ageMs?: number } | undefined {
  const { localChangedAt, remoteChangedAt, baseSyncedAt } = input;
  if (!Number.isFinite(localChangedAt) || !Number.isFinite(remoteChangedAt)) return undefined;
  if (!(localChangedAt! > 0) || !(remoteChangedAt! > 0)) return undefined;
  const ageMs = Number.isFinite(baseSyncedAt) && baseSyncedAt! > 0 ? Math.max(localChangedAt!, remoteChangedAt!) - baseSyncedAt! : undefined;
  return { localChangedAt: localChangedAt!, remoteChangedAt: remoteChangedAt!, separationMs: Math.abs(localChangedAt! - remoteChangedAt!), ageMs };
}

/** Both additions are always emitted; only their order depends on the evidence. */
function orderExtras(times: { localChangedAt: number; remoteChangedAt: number }, split: RegionSplit): { order: NonNullable<DivergenceDecision["order"]>; first: string; second: string } {
  if (Math.abs(times.localChangedAt - times.remoteChangedAt) <= HANDOFF_ORDER_TOLERANCE_MS) {
    // Too close to order honestly: keep a stable order and say so in the reason.
    return { order: "deterministic", first: split.localExtra, second: split.remoteExtra };
  }
  return times.localChangedAt < times.remoteChangedAt
    ? { order: "local-first", first: split.localExtra, second: split.remoteExtra }
    : { order: "remote-first", first: split.remoteExtra, second: split.localExtra };
}

const manual = (reason: string): DivergenceDecision => ({ class: "manual", reason });

/** Classifies one divergence. Pure: the same inputs always produce the same decision. */
export function classifyDivergence(input: DivergenceInput): DivergenceDecision {
  const { base, local, remote } = input;
  // Checked before anything else, and without consulting time or size: when no normalisation at all
  // separates the two sides, they have not disagreed — they have only been stored differently. This is
  // what keeps a line-ending or trailing-whitespace difference from ever becoming a conflict.
  if (significantText(local) === significantText(remote)) {
    return { class: "clean", reason: "the two versions differ only in formatting", mergedText: local, stats: { insertedBytes: 0, deletedBytes: 0, replacedBytes: 0, hunkCount: 0 }, deltas: { local: 0, remote: 0 } };
  }
  if (base === undefined) return manual("no common ancestor was recorded for these two versions");

  const merge = threeWayMerge(asDecoded(base), asDecoded(local), asDecoded(remote));
  if (merge.status === "clean") return { class: "clean", reason: "the two versions changed different parts", mergedText: merge.text };
  if (merge.status === "unavailable") return manual(`the two versions could not be compared (${merge.reason})`);
  if (merge.hunks.length > HANDOFF_MAX_HUNKS) return manual(`the versions disagree in ${merge.hunks.length} regions, which is more than one handoff`);

  const hunk = merge.hunks[0]!;
  const split = splitRegion(base, local, remote, hunk);
  if (!split) return manual("a region was replaced or removed rather than added to");

  const stats: ChangeStats = { insertedBytes: byteLength(split.localExtra) + byteLength(split.remoteExtra), deletedBytes: 0, replacedBytes: 0, hunkCount: 1 };
  const deltas = { local: byteLength(split.localExtra), remote: byteLength(split.remoteExtra) };
  const localAdded = significantText(split.localExtra);
  const remoteAdded = significantText(split.remoteExtra);
  // Formatting is not content: a side that added only line endings, trailing spaces or a final newline
  // has not disagreed about anything, so this is settled without consulting time at all.
  if (localAdded === "" && remoteAdded === "") return { class: "clean", reason: "the two versions differ only in formatting", stats, deltas, mergedText: split.prefix + hunk.base + split.localExtra + split.suffix };
  if (remoteAdded === "") return { class: "clean", reason: "the other version changed only formatting here", stats, deltas, mergedText: split.prefix + hunk.base + split.localExtra + split.suffix };
  if (localAdded === "") return { class: "clean", reason: "this device changed only formatting here", stats, deltas, mergedText: split.prefix + hunk.base + split.remoteExtra + split.suffix };

  const times = usableTimes(input);
  if (!times) return manual("the change times are missing, so this cannot be treated as a device handoff");
  if (times.separationMs > HANDOFF_MAX_SEPARATION_MS) return manual(`the two sides were written ${Math.round(times.separationMs / 1000)}s apart, longer than a handoff`);
  if (stats.insertedBytes > HANDOFF_MAX_DELTA_BYTES) return manual(`the two sides added ${stats.insertedBytes} bytes, more than a handoff`);

  const ordered = orderExtras(times, split);
  return {
    class: "handoff",
    reason: ordered.order === "deterministic"
      ? "both versions added text within moments of each other, and they are too close in time to order"
      : "both versions added text within moments of each other",
    mergedText: split.prefix + hunk.base + ordered.first + ordered.second + split.suffix,
    stats,
    deltas,
    branchSeparationMs: times.separationMs,
    ...(times.ageMs === undefined ? {} : { branchAgeMs: times.ageMs }),
    order: ordered.order,
  };
}
