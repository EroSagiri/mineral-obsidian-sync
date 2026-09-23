import { sha256 } from "../sync/fingerprint";
import type { SyncHistoryEntry, SyncHistoryEventType, SyncHistoryMetadata, SyncHistorySnapshot } from "./types";

/**
 * History entry construction: the builders that shape an entry, plus the display text the viewer shows.
 *
 * Hashing goes through the repository's one platform digest (`sha256`), so a snapshot's hash is the
 * same value the sync path computes for the same text. That makes the builders asynchronous; every
 * caller is already on a path that awaits a network round-trip, and a history write never gates a
 * transfer, so the promise costs nothing that matters. The two description helpers stay synchronous:
 * they only read fields.
 */

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Snapshot from normalised text. */
export async function snapshotOf(content: string, options: { etag?: string; modified?: number } = {}): Promise<SyncHistorySnapshot> {
  const bytes = utf8(content);
  return {
    content,
    sha256: (await sha256(bytes)).value,
    size: bytes.length,
    ...(options.etag === undefined ? {} : { etag: options.etag }),
    ...(options.modified === undefined ? {} : { modified: options.modified }),
  };
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * A short, sortable-by-eye id: the timestamp in base 36, then random characters.
 *
 * The timestamp prefix keeps ids readable and collision-free for events in different milliseconds; the
 * random suffix is what distinguishes two entries recorded in the same millisecond. `random` is a
 * parameter only so a test can make the suffix deterministic.
 */
export function newHistoryId(now: number, random: () => number = Math.random): string {
  let suffix = "";
  for (let index = 0; index < 8; index++) {
    // `% length` also guards a `random` stub that returns exactly 1.
    suffix += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length) % ID_ALPHABET.length];
  }
  return `h${now.toString(36)}-${suffix}`;
}

export interface MergeHistoryInput {
  channel: string;
  path: string;
  type: Extract<SyncHistoryEventType, "clean-auto-merge" | "handoff-auto-merge">;
  timestamp: number;
  /** The recorded ancestor, when one was available; absent when the merge grew from nothing. */
  base?: SyncHistorySnapshot;
  localBefore?: SyncHistorySnapshot;
  remoteBefore?: SyncHistorySnapshot;
  /** The text that landed, and the object version it landed as. */
  result: string;
  resultETag?: string;
  resultModified?: number;
  metadata?: SyncHistoryMetadata;
  id?: string;
}

/** Builds the entry for a merge that actually landed. */
export async function mergeHistoryEntry(input: MergeHistoryInput): Promise<SyncHistoryEntry> {
  return {
    id: input.id ?? newHistoryId(input.timestamp),
    channel: input.channel,
    path: input.path,
    type: input.type,
    timestamp: input.timestamp,
    ...(input.base === undefined ? {} : { base: input.base }),
    ...(input.localBefore === undefined ? {} : { localBefore: input.localBefore }),
    ...(input.remoteBefore === undefined ? {} : { remoteBefore: input.remoteBefore }),
    result: await snapshotOf(input.result, { etag: input.resultETag, modified: input.resultModified }),
    metadata: { ...input.metadata },
  };
}

export interface ManualHistoryInput {
  channel: string;
  path: string;
  conflictId: string;
  timestamp: number;
  /** The resolution intent the user chose: `merged`, `keep-local`, and so on. */
  resolutionType: string;
  base?: SyncHistorySnapshot;
  localBefore?: SyncHistorySnapshot;
  remoteBefore?: SyncHistorySnapshot;
  /** The exact text the resolution applied. */
  result: string;
  resultETag?: string;
  resultModified?: number;
  metadata?: SyncHistoryMetadata;
}

/**
 * Builds the entry for a user resolution that landed.
 *
 * The id is derived from the conflict identity, so recording the same landed resolution twice replaces
 * that one record instead of duplicating it; a new disagreement gets a new conflict id and therefore a
 * new history entry. The prefix keeps these ids out of the auto-merge id space.
 */
export async function manualHistoryEntry(input: ManualHistoryInput): Promise<SyncHistoryEntry> {
  return {
    id: `manual-${input.conflictId}`,
    channel: input.channel,
    path: input.path,
    type: "manual-conflict-resolved",
    timestamp: input.timestamp,
    ...(input.base === undefined ? {} : { base: input.base }),
    ...(input.localBefore === undefined ? {} : { localBefore: input.localBefore }),
    ...(input.remoteBefore === undefined ? {} : { remoteBefore: input.remoteBefore }),
    result: await snapshotOf(input.result, { etag: input.resultETag, modified: input.resultModified }),
    metadata: { ...input.metadata, resolutionType: input.resolutionType },
  };
}

export interface RestoreHistoryInput {
  channel: string;
  path: string;
  timestamp: number;
  /** The history entry whose snapshot became current, so the user can trace the recovery. */
  sourceHistoryId: string;
  /** What the file held immediately before the restore, so the restore itself can be undone. */
  previousCurrent: SyncHistorySnapshot;
  /** The restored text, as it became current. */
  result: string;
  resultETag?: string;
  resultModified?: number;
  metadata?: SyncHistoryMetadata;
  id?: string;
}

/**
 * Builds the entry for a restore the user performed.
 *
 * A restore is a new event, never a rewrite of history: it gets a fresh id even when the snapshot it
 * restored already has an entry of its own.
 */
export async function restoreHistoryEntry(input: RestoreHistoryInput): Promise<SyncHistoryEntry> {
  return {
    id: input.id ?? newHistoryId(input.timestamp),
    channel: input.channel,
    path: input.path,
    type: "restore",
    timestamp: input.timestamp,
    previousCurrent: input.previousCurrent,
    result: await snapshotOf(input.result, { etag: input.resultETag, modified: input.resultModified }),
    metadata: { ...input.metadata, sourceHistoryId: input.sourceHistoryId },
  };
}

/** Short, user-facing description of an event. */
export function describeHistoryEntry(entry: SyncHistoryEntry): string {
  switch (entry.type) {
    case "clean-auto-merge": return "Auto-merged non-overlapping changes";
    case "handoff-auto-merge": return "Auto-merged a short device handoff";
    case "manual-conflict-resolved": return "Conflict resolved manually";
    case "restore": return "Restored an earlier version";
  }
}

/** Rounds to one decimal and drops a trailing `.0`, so "2 kB" reads better than "2.0 kB". */
const round1 = (value: number): number => Math.round(value * 10) / 10;

function byteLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${round1(bytes / 1024)} kB`;
  return `${round1(bytes / (1024 * 1024))} MB`;
}

function durationLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${round1(ms / 1000)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${round1(ms / 3_600_000)}h`;
  return `${round1(ms / 86_400_000)}d`;
}

/**
 * One line of evidence, built only from facts the entry actually recorded.
 *
 * Policy facts (`mergeReason`, `order`, the resolution type) are deliberately not evidence of *scale*
 * and stay in the viewer's technical details; this line answers "how big a change was this, and how
 * far apart were the two sides".
 */
export function describeHistoryEvidence(entry: SyncHistoryEntry): string | undefined {
  const metadata = entry.metadata;
  const parts: string[] = [];

  const deltas = [metadata.localDeltaBytes, metadata.remoteDeltaBytes].filter((value): value is number => value !== undefined);
  if (deltas.length) {
    // Both deltas describe additions against the same ancestor, so their sum is the change the merge
    // had to reconcile; a single recorded delta is used on its own.
    const total = deltas.reduce((sum, value) => sum + value, 0);
    if (total !== 0) parts.push(total > 0 ? `${byteLabel(total)} added` : `${byteLabel(-total)} removed`);
  }

  if (metadata.branchSeparationMs !== undefined) parts.push(`${durationLabel(metadata.branchSeparationMs)} apart`);
  else if (metadata.branchAgeMs !== undefined) parts.push(`${durationLabel(metadata.branchAgeMs)} old`);

  if (metadata.hunkCount !== undefined) parts.push(`${metadata.hunkCount} ${metadata.hunkCount === 1 ? "region" : "regions"}`);

  return parts.length ? parts.join(" · ") : undefined;
}
