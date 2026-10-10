import type { Vault } from "obsidian";
import { RemoteHttpError, RemoteObjectChangedError } from "../remote/errors";
import type { R2Client } from "../remote/r2-client";
import type { LocalEntry, PreviousEntry, RemoteDeletionIdentity, RemoteEntry, SyncOperation } from "../sync/types";
import { MAX_MERGEABLE_BYTES, decodeText, isMergeablePath, preferredShape } from "../sync/text";
import { threeWayMerge } from "../sync/merge";
import { pathDigest } from "../sync/path";
import { classifyDivergence } from "./handoff";
import { baselineMatches, conflictIdFor, sha256Hex, shortConflictId } from "./identity";
import { CONFLICT_PROTOCOL_VERSION, isAutoResolved, type AutoMergeStatus, type ConflictRecord, type ConflictStore, type MergeBaseRecord, type MergeBaseStore, type ResolutionIntent, type ResolutionIntentStore } from "./types";

/**
 * Turns "the planner says this key is conflicted" into either an automatic resolution proposal or a
 * persisted, user-visible conflict.
 *
 * Boundaries this class deliberately respects:
 *
 * - it never mutates a Vault file and never writes to R2;
 * - the only thing it persists that can change sync behaviour is a `ResolutionIntent`, which the
 *   planner is free to reject;
 * - it performs no operation substitution inside a running cycle, so `planner` remains the single
 *   decision maker.
 *
 * It also owns the one synchronous input the planner needs: the set of intents that are valid for the
 * *current* observations. Because the planner must stay a pure function, that map is computed here
 * (after a cycle, from real I/O) and handed to the next cycle's `buildSyncPlan` call.
 */
export interface ConflictCoordinatorDependencies {
  vault: Vault;
  client: R2Client;
  channel: string;
  mergeBase: MergeBaseStore;
  conflicts: ConflictStore;
  intents: ResolutionIntentStore;
  /**
   * Asks for a reconciliation after a proposal or conflict was recorded.
   *
   * The reason is passed through so an explicit user action can be scheduled differently from an
   * automatic merge: a click deserves an immediate cycle, while an auto-merge can wait out a debounce.
   */
  requestReconcile(reason: "conflict-auto-merge" | "conflict-manual-resolution"): void;
  debug?(message: string): void;
  now?(): number;
}

export interface ConflictDetectionInput {
  key: string;
  previous?: PreviousEntry;
  observedLocal?: LocalEntry;
  observedRemote?: RemoteEntry;
  observedRemoteDeletion?: RemoteDeletionIdentity;
}

export class ConflictCoordinator {
  /** Conflict ids this session has already attempted, so a manual-required conflict is not retried. */
  private readonly attempted = new Set<string>();
  /**
   * Intents valid for the current observations, refreshed after each cycle. The planner consumes this
   * synchronously; it is the *only* channel through which a user decision reaches planning.
   */
  private readonly active = new Map<string, { intent: ResolutionIntent }>();
  private readonly now: () => number;

  constructor(private readonly dependencies: ConflictCoordinatorDependencies) { this.now = dependencies.now ?? (() => Date.now()); }
  /**
   * Pins the channel for the current cycle. Every record, snapshot and intent this coordinator writes
   * is keyed by it, so a namespace switch can never mix two namespaces' conflict state.
   */
  setChannel(channel: string): void {
    if (this.dependencies.channel === channel) return;
    this.dependencies.channel = channel;
    // A different namespace is a different conflict space: nothing cached may carry over.
    this.attempted.clear();
    this.active.clear();
  }

  /**
   * The proposals the next plan may act on. Synchronous by design: `buildSyncPlan` must not do I/O,
   * and this map was computed from a real, completed cycle's observations.
   */
  resolutions(): Map<string, { intent: ResolutionIntent }> { return this.active; }

  /** The conflict records the resolver UI should show. */
  async list(): Promise<ConflictRecord[]> {
    if (!this.dependencies.channel) return [];
    try { return await this.dependencies.conflicts.listConflicts(this.dependencies.channel); }
    catch { return []; }
  }

  /** True when no intent is pending for this path, so the UI can distinguish a fresh conflict. */
  async hasIntentFor(path: string): Promise<boolean> {
    const intents = await this.intents();
    return intents.some((intent) => intent.path === path);
  }

  /**
   * Called once per cycle with the conflicts the planner produced. Returns the intents that are valid
   * for the current observations, which the next cycle's planner is allowed to act on.
   */
  async handleConflicts(conflicts: ConflictDetectionInput[]): Promise<void> {
    if (!this.dependencies.channel) return;
    const active = new Map<string, string>();
    // Both outcomes need a follow-up cycle: a recorded conflict (so the user sees it, and so the
    // intent list is refreshed) and an automatic merge (so the planner can actually apply it).
    let followUp = false;
    for (const conflict of conflicts) {
      const record = await this.inspect(conflict);
      if (!record) continue;
      active.set(record.path, record.conflictId);
      // An automatically settled divergence is never surfaced as something to decide, but it *is*
      // recorded: the record carries the ancestor and both sides, which is what lets the history entry
      // show what was merged and offer either side back. The resolver and the status count both filter
      // on `isAutoResolved`, so recording it here costs the user nothing.
      if (isAutoResolved(record.autoMergeStatus)) {
        await this.safePutConflict(record);
        followUp = true;
        continue;
      }
      // A conflict we have already examined in this session is not re-attempted on every cycle.
      if (this.attempted.has(record.conflictId)) {
        // Still refresh the visible record so the UI can show it, but do not re-run the merge.
        await this.safePutConflict(record);
        continue;
      }
      this.attempted.add(record.conflictId);
      await this.safePutConflict(record);
      this.dependencies.debug?.(`conflict detected path-hash=${shortConflictId(record.conflictId)} base=${record.snapshot.baseAvailable ? "available" : "unavailable"} autoMerge=${record.autoMergeStatus}`);
      followUp = true;
    }
    // Only conflicts that are still active survive; a superseded identity is dropped so a stale user
    // decision can never be applied to it later.
    try { await this.dependencies.conflicts.reconcile(this.dependencies.channel, active); } catch { this.dependencies.debug?.("conflict store reconcile failed"); }
    // Refresh the proposals the *next* plan may apply, from this cycle's real observations.
    const intentBecameValid = await this.refreshValidIntents(new Map(conflicts.map((conflict) => [conflict.key, conflict])));
    // A manual choice is persisted between cycles. Its first follow-up cycle is deliberately still
    // a conflict while this method validates it against fresh observations; now that it is valid,
    // schedule one immediate *additional* cycle for the planner to execute it. Without this, the
    // intent remains stored but is never consumed until an unrelated later event happens.
    if (followUp) this.dependencies.requestReconcile("conflict-auto-merge");
    else if (intentBecameValid) this.dependencies.requestReconcile("conflict-manual-resolution");
  }

  /** Reads the intents that match the current observations and caches them for the planner. */
  private async refreshValidIntents(observations: Map<string, ConflictDetectionInput>): Promise<boolean> {
    const previouslyActive = new Map(this.active);
    this.active.clear();
    if (!this.dependencies.channel) return false;
    const stale: string[] = [];
    for (const intent of await this.intents()) {
      const observation = observations.get(intent.path);
      if (!observation) continue;
      const currentId = await this.identityOf(observation);
      // The intent carries the conflict identity it was authored against. Equality here is the whole
      // guarantee that a decision cannot be applied to versions the user never saw.
      if (currentId === intent.conflictId) this.active.set(intent.path, { intent });
      // A record from an older conflict model, or a click against an earlier version, can never
      // become valid again for this observation. Remove only that proven-stale proposal; an intent
      // for a path absent from this scan is retained because the scan may simply be incomplete.
      else stale.push(intent.conflictId);
    }
    if (stale.length) try { await this.dependencies.intents.removeIntents(this.dependencies.channel, stale); }
    catch { this.dependencies.debug?.("stale resolution-intent cleanup failed"); }
    return [...this.active.entries()].some(([path, proposal]) => previouslyActive.get(path)?.intent.conflictId !== proposal.intent.conflictId);
  }

  private async intents(): Promise<ResolutionIntent[]> {
    if (!this.dependencies.channel) return [];
    try { return await this.dependencies.intents.listIntents(this.dependencies.channel); }
    catch { return []; }
  }

  /**
   * Records a resolution the user or the auto-merge produced. This is the **only** write path the UI
   * uses; it stores an intent and asks for a reconciliation, and never touches file content.
   */
  async propose(intent: ResolutionIntent, reason: "conflict-auto-merge" | "conflict-manual-resolution" = "conflict-manual-resolution"): Promise<void> {
    await this.dependencies.intents.putIntent(intent);
    this.dependencies.debug?.(`resolution intent type=${intent.type} path-hash=${shortConflictId(intent.conflictId)}`);
    this.dependencies.requestReconcile(reason);
  }

  /**
   * Clears the conflict and its intent once a resolution has actually been applied, and makes the
   * intent immediately unusable so it cannot be applied a second time.
   */
  async clear(conflictId: string, path?: string): Promise<void> {
    if (path) this.active.delete(path);
    try {
      await this.dependencies.conflicts.removeConflicts(this.dependencies.channel, [conflictId]);
      await this.dependencies.intents.removeIntents(this.dependencies.channel, [conflictId]);
    } catch { this.dependencies.debug?.("conflict cleanup failed"); }
    this.attempted.delete(conflictId);
  }

  async intentFor(path: string): Promise<ResolutionIntent | undefined> {
    return (await this.intents()).find((intent) => intent.path === path);
  }

  // ---- internals --------------------------------------------------------------------------------

  private async identityOf(input: ConflictDetectionInput): Promise<string> {
    return conflictIdFor({ channel: this.dependencies.channel, path: input.key, previous: input.previous, observedLocal: input.observedLocal, observedRemote: input.observedRemote });
  }

  /**
   * Builds the current conflict record, attempting an automatic merge when — and only when — a
   * trustworthy base snapshot exists for exactly this baseline.
   */
  private async inspect(input: ConflictDetectionInput): Promise<ConflictRecord | undefined> {
    const { key, previous, observedLocal, observedRemote, observedRemoteDeletion } = input;
    if (!previous || (!observedLocal && !observedRemote)) return undefined;
    const conflictId = await this.identityOf(input);
    const base: ConflictRecord = {
      protocolVersion: CONFLICT_PROTOCOL_VERSION,
      conflictId,
      channel: this.dependencies.channel,
      path: key,
      previous: { localVersion: previous.local ? { key, size: previous.local.size, mtime: previous.local.mtime } : observedLocal!, remoteETag: previous.remote?.etag },
      observedLocal,
      observedRemoteETag: observedRemote?.etag,
      observedRemoteDeletion,
      detectedAt: this.now(),
      autoMergeStatus: "not-attempted",
      snapshot: { baseAvailable: false },
    };

    // Deletion-vs-modify is a semantic conflict, never a text merge. It intentionally has no body
    // reads and exposes only its two safe, version-bound decisions in the resolver.
    if (!observedLocal || !observedRemote || observedRemoteDeletion) return { ...base, autoMergeStatus: "manual-required", reason: observedRemoteDeletion ? "remote logical deletion conflicts with a local modification" : "local deletion conflicts with a remote modification" };
    // Policy gates come first: an unsupported type or an oversized body is manual by definition and
    // must not even be read.
    if (!isMergeablePath(key)) return { ...base, autoMergeStatus: "unsupported", reason: "only markdown and plain-text files are merged automatically" };
    if (observedLocal.size > MAX_MERGEABLE_BYTES || observedRemote.size > MAX_MERGEABLE_BYTES) return { ...base, autoMergeStatus: "too-large", reason: `larger than the ${MAX_MERGEABLE_BYTES} byte merge ceiling` };

    let snapshot: MergeBaseRecord | undefined;
    try { snapshot = await this.dependencies.mergeBase.get(this.dependencies.channel, key); }
    catch { this.dependencies.debug?.("merge base read failed"); }
    // A snapshot describes one baseline, not one path. If the baseline has moved, the snapshot can no
    // longer serve as a merge base and must not be used as one.
    if (!snapshot || !baselineMatches(snapshot.baseline, previous)) {
      return { ...base, autoMergeStatus: "base-unavailable", reason: "no merge-base snapshot was recorded for this baseline; this conflict predates merge-base support" };
    }

    const localBytes = await this.readLocal(key);
    if (!localBytes) return { ...base, autoMergeStatus: "base-unavailable", reason: "the local file could not be read" };
    let remoteBytes: Uint8Array;
    try { remoteBytes = new Uint8Array(await this.dependencies.client.getObject(key, { ifMatch: observedRemote.etag })); }
    catch (error) {
      if (error instanceof RemoteObjectChangedError) return { ...base, autoMergeStatus: "manual-required", reason: "the remote changed while the conflict was being examined" };
      if (error instanceof RemoteHttpError) return { ...base, autoMergeStatus: "manual-required", reason: `the remote snapshot could not be read (HTTP ${error.status})` };
      return { ...base, autoMergeStatus: "manual-required", reason: "the remote snapshot could not be read" };
    }

    const local = decodeText(localBytes), remote = decodeText(remoteBytes);
    const baseText = { text: snapshot.content, shape: snapshot.encoding };
    if (!local || !remote) return { ...base, autoMergeStatus: "decode-failed", reason: "one side is not valid UTF-8 text", snapshot: { baseAvailable: true, base: snapshot.content } };

    // One decision, three levels. The policy settles what it can prove — a non-colliding merge, or a
    // short handoff of small additions from a recorded ancestor — and hands everything else to the
    // user. It never guesses at meaning, and every threshold it applies lives in the policy module.
    const decision = classifyDivergence({
      base: snapshot.content,
      local: local.text,
      remote: remote.text,
      // All three stamps are already here: the local file's mtime, the object's own last-modified, and
      // when this device last committed the ancestor both branches grew from.
      localChangedAt: observedLocal.mtime,
      remoteChangedAt: observedRemote.lastModified,
      baseSyncedAt: previous.syncedAt,
    });
    const evidence = decision.stats && decision.class !== "clean"
      ? {
          reason: decision.reason,
          ...(decision.branchSeparationMs === undefined ? {} : { branchSeparationMs: decision.branchSeparationMs }),
          ...(decision.branchAgeMs === undefined ? {} : { branchAgeMs: decision.branchAgeMs }),
          localDeltaBytes: decision.deltas?.local ?? 0,
          remoteDeltaBytes: decision.deltas?.remote ?? 0,
          hunkCount: decision.stats.hunkCount,
          ...(decision.order === undefined ? {} : { order: decision.order }),
        }
      : undefined;

    if (decision.class === "manual" || decision.mergedText === undefined) {
      const draft = threeWayMerge(baseText, local, remote);
      // The policy's own explanation, except in the impossible case of a settled class with no content:
      // that is undecided, and must not be described by a reason that says otherwise.
      const reason = decision.class === "manual" ? decision.reason : "a settled merge produced no content to apply";
      return { ...base, autoMergeStatus: "manual-required", reason, snapshot: { baseAvailable: true, base: snapshot.content, local: local.text, remote: remote.text, ...(draft.status === "conflict" ? { draft: draft.draft } : {}) } };
    }

    // A settled divergence becomes a `merged` intent — a proposal, not an action. The planner applies it
    // on the next cycle, so this cycle's plan is never silently rewritten underneath itself.
    const sha256 = await sha256Hex(new TextEncoder().encode(decision.mergedText));
    const intent: ResolutionIntent = {
      protocolVersion: CONFLICT_PROTOCOL_VERSION,
      conflictId,
      channel: this.dependencies.channel,
      path: key,
      type: "merged",
      origin: "auto",
      expectedLocalVersion: observedLocal,
      expectedRemoteETag: observedRemote.etag,
      createdAt: this.now(),
      merged: { content: decision.mergedText, sha256, encoding: preferredShape(local.shape, remote.shape, baseText.shape) },
    };
    try { await this.dependencies.intents.putIntent(intent); } catch { return { ...base, autoMergeStatus: "manual-required", reason: "the merge succeeded but could not be recorded" }; }
    if (decision.class === "handoff") {
      this.dependencies.debug?.(`auto merge strategy=handoff path-digest=${pathDigest(key)} branchSeparationMs=${Math.round(decision.branchSeparationMs ?? -1)} deltaBytes=${decision.stats!.insertedBytes} hunks=${decision.stats!.hunkCount} order=${decision.order}`);
    } else {
      this.dependencies.debug?.(`auto merge strategy=clean path-digest=${pathDigest(key)} reason=${decision.reason}`);
    }
    return {
      ...base,
      autoMergeStatus: decision.class,
      reason: decision.reason,
      ...(evidence === undefined ? {} : { handoff: evidence }),
      snapshot: { baseAvailable: true, base: snapshot.content, local: local.text, remote: remote.text, draft: decision.mergedText },
    };
  }

  private async readLocal(key: string): Promise<Uint8Array | undefined> {
    const file = this.dependencies.vault.getFileByPath(key);
    if (!file) return undefined;
    try { return new Uint8Array(await this.dependencies.vault.readBinary(file)); } catch { return undefined; }
  }

  private async safePutConflict(record: ConflictRecord): Promise<void> {
    try { await this.dependencies.conflicts.putConflict(record); } catch { this.dependencies.debug?.("conflict record write failed"); }
  }
}

export type { AutoMergeStatus, ConflictRecord, ResolutionIntent };
export type ConflictOperation = Extract<SyncOperation, { type: "conflict" }>;
