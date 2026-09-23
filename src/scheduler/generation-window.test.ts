import { describe, expect, it } from "vitest";
import { SyncScheduler } from "./scheduler";
import type { CycleDependencies, SchedulerRemoteChange, SchedulerTimers } from "./types";
import type { OperationResult } from "../sync/executor";
import type { LocalEntry, PreviousEntry, RemoteEntry, SyncOperation } from "../sync/types";
import type { RemoteChange } from "@mineral/sync-core/sync-change";

/**
 * Generation retirement and remote-delta scheduling.
 *
 * Two rules are pinned down here: a window that cannot cover a generation must not retire it, and a
 * queued remote delta must always end up in a cycle that can consume it — even when the reason that
 * would have done so was overwritten by a concurrent local edit.
 */

class FakeTimers implements SchedulerTimers {
  private next = 1;
  readonly jobs = new Map<number, { delay: number; callback: () => void }>();
  set(delay: number, callback: () => void): unknown { const id = this.next++; this.jobs.set(id, { delay, callback }); return id; }
  clear(handle: unknown): void { this.jobs.delete(handle as number); }
  fire(delay?: number): void {
    const found = [...this.jobs.entries()].sort((a, b) => a[1].delay - b[1].delay).find(([, job]) => delay === undefined || job.delay === delay);
    if (!found) throw new Error(`No timer for ${delay ?? "next"}`);
    this.jobs.delete(found[0]); found[1].callback();
  }
  delays(): number[] { return [...this.jobs.values()].map((job) => job.delay); }
}

const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

/** Mirrors the real Gateway client: a delta is only applicable when it is the exact next generation. */
function fakeRemote(reconciled = "80", announced = "81") {
  const confirmed: string[] = [];
  const notified: unknown[][] = [];
  const state = { reconciled, announced };
  const remote: SchedulerRemoteChange = {
    hasPending: () => BigInt(state.announced) > BigInt(state.reconciled),
    readGeneration: async () => ({ ok: true, generation: state.announced }),
    confirmReconciled: async (value) => { confirmed.push(value); state.reconciled = value; },
    notifyRemoteDirty: async (changes) => { notified.push([...(changes ?? [])]); return { ok: true, generation: state.reconciled }; },
    canApplyIncrementally: (generation) => BigInt(generation) === BigInt(state.reconciled) + 1n,
  };
  return { remote, confirmed, notified, announce: (generation: string) => { state.announced = generation; } };
}

const NOTE_LOCAL: LocalEntry = { key: "note.md", size: 5, mtime: 10 };
const NOTE_REMOTE: RemoteEntry = { key: "note.md", size: 5, etag: "ETAG-2", lastModified: 20 };
const NOTE_PREVIOUS: PreviousEntry = { key: "note.md", local: { size: 5, mtime: 10 }, remote: { size: 5, etag: "ETAG-1" }, syncedAt: 1 };
const DOWNLOAD: SyncOperation = { type: "download", key: "note.md", reason: "remote changed", expectedLocal: NOTE_LOCAL, expectedRemote: NOTE_REMOTE };

function harness(execute: CycleDependencies["execute"], ingest?: { reported: unknown[][]; announces?: boolean }) {
  const timers = new FakeTimers();
  const { remote, confirmed, notified, announce } = fakeRemote();
  const observedLocally: string[][] = [];
  const observedIncrementally: RemoteChange[][] = [];
  // Starts empty so that establishing a trusted window via `startup` executes nothing; a test then
  // publishes the plan it wants the delta cycle to run.
  const plan: { operations: SyncOperation[] } = { operations: [] };
  let fullRemoteScans = 0;
  const cycle = (): CycleDependencies => ({
    scanLocal: () => new Map([[NOTE_LOCAL.key, NOTE_LOCAL]]),
    scanRemote: async () => { fullRemoteScans++; return new Map([[NOTE_REMOTE.key, NOTE_REMOTE]]); },
    loadPrevious: async () => new Map([[NOTE_PREVIOUS.key, NOTE_PREVIOUS]]),
    filterPrevious: (entries) => entries,
    incrementalObservations: async (changes: RemoteChange[]) => {
      observedIncrementally.push(changes);
      return { local: new Map([[NOTE_LOCAL.key, NOTE_LOCAL]]), remote: new Map([[NOTE_REMOTE.key, NOTE_REMOTE]]), previous: new Map([[NOTE_PREVIOUS.key, NOTE_PREVIOUS]]) };
    },
    localIncrementalObservations: async (keys: string[]) => {
      observedLocally.push(keys);
      return { local: new Map([[NOTE_LOCAL.key, NOTE_LOCAL]]), remote: new Map(), previous: new Map() };
    },
    buildPlan: () => ({ operations: plan.operations }),
    execute,
  });
  const scheduler = new SyncScheduler({
    captureCycle: cycle, visible: () => true, timers, remoteChange: remote,
    ...(ingest ? {
      mutationIngress: {
        report: async (changes) => { ingest.reported.push([...changes]); },
        announcesLandedWrites: () => ingest.announces ?? false,
      },
    } : {}),
  });
  return { scheduler, timers, confirmed, notified, announce, observedLocally, observedIncrementally, plan, fullRemoteScans: () => fullRemoteScans };
}

/** One confirmed full window is what makes an exact-next-generation delta applicable. */
async function establishTrustedWindow(env: ReturnType<typeof harness>) {
  env.scheduler.requestReconcile("startup");
  env.timers.fire(1200);
  await flush();
  expect(env.confirmed).toEqual(["81"]);
  expect(env.scheduler.diagnostics().lastConfirmation).toBe("confirmed");
}

describe("remote delta scheduling", () => {
  it("consumes a delta whose remote-change reason was overwritten by a local edit", async () => {
    const env = harness(async (operation) => ({ status: "applied", key: operation.key }));
    await establishTrustedWindow(env);

    // A delta arrives, and a local edit owns the debounce before it can run.
    env.announce("82");
    env.scheduler.requestRemoteChange("82", [{ op: "put", path: "note.md" }]);
    env.scheduler.markLocalPaths(["note.md"], () => false);
    expect(env.timers.delays()).toEqual([1200]);

    env.timers.fire(1200);
    await flush();

    // The local window observed one path, so it can neither retire generation 82 nor drop its delta.
    expect(env.observedLocally).toEqual([["note.md"]]);
    expect(env.observedIncrementally).toEqual([]);
    expect(env.confirmed).toEqual(["81"]);
    expect(env.scheduler.diagnostics().pendingRemoteDeltaCount).toBe(1);
    // The delta carries its own scheduled cycle instead of waiting for another announcement.
    expect(env.timers.delays()).toEqual([0]);

    env.timers.fire(0);
    await flush();

    expect(env.observedIncrementally).toEqual([[{ op: "put", path: "note.md" }]]);
    expect(env.confirmed).toEqual(["81", "82"]);
    expect(env.scheduler.diagnostics().pendingRemoteDeltaCount).toBe(0);
    expect(env.timers.delays()).toEqual([]);
  });

  it("keeps retrying a delta whose local half is landing-unknown, and retires it only when it applies", async () => {
    let attempt = 0;
    const env = harness(async (operation) => {
      attempt++;
      // The first pass leaves a local side effect nobody can account for.
      return attempt === 1
        ? { status: "partial", key: operation.key, reason: "remote-write-landing-unknown" }
        : { status: "applied", key: operation.key };
    });
    await establishTrustedWindow(env);
    env.plan.operations = [DOWNLOAD];

    env.announce("82");
    env.scheduler.requestRemoteChange("82", [{ op: "put", path: "note.md" }]);
    env.timers.fire(0);
    await flush();

    // Landing-unknown must not retire the generation, and the delta stays queued for the retry.
    expect(env.scheduler.diagnostics().lastResultCounts.partial).toBe(1);
    expect(env.confirmed).toEqual(["81"]);
    expect(env.scheduler.diagnostics().lastConfirmation).toBe("observation-incomplete");
    expect(env.scheduler.diagnostics().pendingRemoteDeltaCount).toBe(1);
    expect(env.timers.delays()).toEqual([0]);

    env.timers.fire(0);
    await flush();

    expect(env.confirmed).toEqual(["81", "82"]);
    expect(env.scheduler.diagnostics().lastConfirmation).toBe("confirmed");
    expect(env.scheduler.diagnostics().pendingRemoteDeltaCount).toBe(0);
  });

  it("still retires a generation for a failure that provably left no side effect", async () => {
    const env = harness(async (operation) => ({ status: "failed", key: operation.key, error: "path", reason: "parent-path-is-file" }));
    await establishTrustedWindow(env);
    env.plan.operations = [DOWNLOAD];

    env.announce("82");
    env.scheduler.requestRemoteChange("82", [{ op: "put", path: "note.md" }]);
    env.timers.fire(0);
    await flush();

    // A definitive local rejection is a deterministic conclusion about this device, not an unknown: the
    // remote window was fully observed, so the generation is retired and nothing is left queued.
    expect(env.scheduler.diagnostics().lastResultCounts.failed).toBe(1);
    expect(env.confirmed).toEqual(["81", "82"]);
    expect(env.scheduler.diagnostics().lastConfirmation).toBe("confirmed");
    expect(env.scheduler.diagnostics().pendingRemoteDeltaCount).toBe(0);
    expect(env.timers.delays()).toEqual([]);
  });

  it("does not let a queued delta bypass a retryable backoff", async () => {
    const env = harness(async (operation) => ({ status: "unresolved", key: operation.key, reason: "ambiguous-put" }));
    await establishTrustedWindow(env);
    env.plan.operations = [DOWNLOAD];

    env.announce("82");
    env.scheduler.requestRemoteChange("82", [{ op: "put", path: "note.md" }]);
    env.timers.fire(0);
    await flush();

    // An outage keeps its exponential backoff rather than turning the delta into an immediate spin.
    expect(env.confirmed).toEqual(["81"]);
    expect(env.scheduler.diagnostics().pendingRemoteDeltaCount).toBe(1);
    expect(env.timers.delays()).toEqual([5000]);
  });
});

/**
 * A deletion is subject to generation ordering exactly like a write.
 *
 * The fast path exists so a remote deletion can be applied without listing the bucket, and that is only
 * sound while the client knows it has seen every generation up to this one. A gap means it does not, so
 * the deletion must wait for a full reconciliation instead of being applied on its own.
 */
describe("a remote delete is generation-protected", () => {
  const DELETE: RemoteChange = { op: "delete", path: "note.md" };

  it("applies an exact-next-generation deletion without listing anything", async () => {
    const env = harness(async (operation) => ({ status: "applied", key: operation.key }));
    await establishTrustedWindow(env);
    env.plan.operations = [{ type: "delete-local", key: "note.md", reason: "remote deletion", expectedLocal: NOTE_LOCAL }];
    const scansBefore = env.fullRemoteScans();

    env.announce("82");
    env.scheduler.requestRemoteChange("82", [DELETE]);
    env.timers.fire(0);
    await flush();

    expect(env.observedIncrementally).toEqual([[DELETE]]);
    expect(env.confirmed).toEqual(["81", "82"]);
    // No full reconcile: the delta answered for its own path.
    expect(env.fullRemoteScans()).toBe(scansBefore);
  });

  it("falls back to a full reconciliation when the generations in between were never seen", async () => {    const env = harness(async (operation) => ({ status: "applied", key: operation.key }));
    await establishTrustedWindow(env);
    env.plan.operations = [{ type: "delete-local", key: "note.md", reason: "remote deletion", expectedLocal: NOTE_LOCAL }];

    // 84 arrives while 82 and 83 were never observed: the deletion cannot be applied on its own, because
    // a write in one of those generations may have recreated the path after it.
    env.announce("84");
    env.scheduler.requestRemoteChange("84", [DELETE]);
    env.timers.fire(0);
    await flush();

    expect(env.observedIncrementally).toEqual([]);
    expect(env.fullRemoteScans()).toBe(2);
    expect(env.confirmed).toEqual(["81", "84"]);
    expect(env.scheduler.diagnostics().pendingRemoteDeltaCount).toBe(0);
  });

  it("never applies a deletion incrementally from a generation that is not the next one", async () => {    const env = harness(async (operation) => ({ status: "applied", key: operation.key }));
    await establishTrustedWindow(env);

    // The client already drops repeated or older generations, so this is the scheduler's own backstop: a
    // queued delta that is not the exact next generation is never consumed as an exact-path observation,
    // and an already-covered generation never moves the cursor backwards.
    env.scheduler.requestRemoteChange("81", [DELETE]);
    env.timers.fire(0);
    await flush();

    expect(env.observedIncrementally).toEqual([]);
    expect(env.confirmed).toEqual(["81", "81"]);
  });

  it("keeps the generation open when a local deletion's landing is unknown", async () => {
    // A removal that raised and left the file gone is not a failure: a side effect exists that no baseline
    // accounts for, so the window may not be called complete and the delta must stay queued.
    const env = harness(async (operation) => ({ status: "partial", key: operation.key, reason: "local-delete-landing-unknown" }));
    await establishTrustedWindow(env);
    env.plan.operations = [{ type: "delete-local", key: "note.md", reason: "remote deletion", expectedLocal: NOTE_LOCAL }];

    env.announce("82");
    env.scheduler.requestRemoteChange("82", [DELETE]);
    env.timers.fire(0);
    await flush();

    expect(env.confirmed).toEqual(["81"]);
    expect(env.scheduler.diagnostics().lastConfirmation).toBe("observation-incomplete");
    expect(env.scheduler.diagnostics().pendingRemoteDeltaCount).toBe(1);
    // The shortfall is retried immediately rather than waiting for an unrelated event.
    expect(env.timers.delays()).toEqual([0]);
  });
});

/**
 * Reporting a landed write to the mutation journal.
 *
 * The report is driven by the *result*, not the operation: only a write whose revision this device
 * actually received can be reported, because the ingress checks it against R2. It also must not be tied
 * to the generation handshake — a delta cycle that reconciles and writes while doing so has landed a fact
 * just as much as a full cycle, and other devices (and the index) need it either way.
 */
describe("landed mutations are reported with their revision", () => {
  const landed = (etag: string, size: number): OperationResult => ({ status: "applied", key: "note.md", remote: { size, etag } });
  const UPLOAD: SyncOperation = { type: "upload", key: "note.md", reason: "local changed", expectedLocal: NOTE_LOCAL, expectedRemote: { kind: "etag", value: "ETAG-1" } };

  it("reports the exact revision the PUT returned, on a delta cycle too", async () => {
    const ingest = { reported: [] as unknown[][] };
    const env = harness(async () => landed("ETAG-2", 5), ingest);
    await establishTrustedWindow(env);
    env.plan.operations = [UPLOAD];

    // A remote-change cycle that resolves a conflict by writing: the delta path confirms its generation
    // without going through the closing handshake, and the write must still reach the journal.
    env.announce("82");
    env.scheduler.requestRemoteChange("82", [{ op: "put", path: "note.md" }]);
    env.timers.fire(0);
    await flush();

    expect(env.observedIncrementally).toHaveLength(1);
    expect(ingest.reported).toEqual([[{ op: "put", path: "note.md", etag: "ETAG-2", size: 5 }]]);
  });

  it("reports a write whose local half did not finish, because the bytes are already visible", async () => {
    const ingest = { reported: [] as unknown[][] };
    const env = harness(async () => ({ status: "partial", key: "note.md", reason: "remote-applied-local-changed", remote: { size: 5, etag: "ETAG-2" } }), ingest);
    await establishTrustedWindow(env);
    env.plan.operations = [UPLOAD];

    env.scheduler.requestReconcile("manual");
    env.timers.fire(0);
    await flush();

    expect(ingest.reported).toEqual([[{ op: "put", path: "note.md", etag: "ETAG-2", size: 5 }]]);
  });

  it("reports nothing for a write whose outcome is unknown, and nothing for a download", async () => {
    const ingest = { reported: [] as unknown[][] };
    const env = harness(async (operation) => operation.type === "upload"
      ? { status: "unresolved", key: operation.key, reason: "ambiguous-put" }
      : { status: "applied", key: operation.key }, ingest);
    await establishTrustedWindow(env);
    env.plan.operations = [UPLOAD, DOWNLOAD];

    env.scheduler.requestReconcile("manual");
    env.timers.fire(0);
    await flush();

    // An ambiguous PUT has no revision to name, and a download wrote nothing remotely at all.
    expect(ingest.reported).toEqual([]);
  });

  it("reports a deletion with the revision it retired, as a journal fact rather than a Gateway hint", async () => {
    const ingest = { reported: [] as unknown[][] };
    const env = harness(async () => ({ status: "applied", key: "note.md", retired: "ETAG-1" }), ingest);
    await establishTrustedWindow(env);
    env.plan.operations = [{ type: "delete-remote", key: "note.md", reason: "local deletion", expectedRemoteETag: "ETAG-1" }];

    env.scheduler.requestReconcile("manual");
    env.timers.fire(0);
    await flush();

    // The Gateway's change vocabulary forbids an ETag on a delete, so the journal gets a delete *fact*
    // while the wake-up hint stays exactly as it was — the two are derived from the same result.
    expect(ingest.reported).toEqual([[{ op: "delete", path: "note.md", etag: "ETAG-1" }]]);
  });

  it("reports nothing for a deletion whose retired revision was never established", async () => {
    const ingest = { reported: [] as unknown[][] };
    const env = harness(async () => ({ status: "applied", key: "note.md" }), ingest);
    await establishTrustedWindow(env);
    env.plan.operations = [{ type: "delete-remote", key: "note.md", reason: "local deletion", expectedRemoteETag: "ETAG-1" }];

    env.scheduler.requestReconcile("manual");
    env.timers.fire(0);
    await flush();

    // A delete with no revision means "the object is gone", which this plugin can never claim about its
    // own logical deletions, so nothing is sent rather than something unverifiable.
    expect(ingest.reported).toEqual([]);
  });
});

/**
 * One writer, one announcer.
 *
 * The Gateway and the mutation journal are a **mode-level** choice, not a fallback: when the ingress
 * announces this device's landed writes, the Vault's Sync Publisher produces their generation, and a
 * second `/dirty` call would bump it again for the same write. A failed report is retried with the
 * same mutation id, so it must never be answered with a `/dirty` call — the report may have been
 * recorded even though its response was lost.
 */
describe("the mutation journal and the gateway never both announce one write", () => {
  const landed: CycleDependencies["execute"] = async () => ({ status: "applied", key: "note.md", remote: { size: 5, etag: "ETAG-2" } });
  const UPLOAD: SyncOperation = { type: "upload", key: "note.md", reason: "local changed", expectedLocal: NOTE_LOCAL, expectedRemote: { kind: "etag", value: "ETAG-1" } };

  async function writeThroughCycle(env: ReturnType<typeof harness>) {
    await establishTrustedWindow(env);
    env.notified.length = 0;
    env.plan.operations = [UPLOAD];
    env.scheduler.requestReconcile("manual");
    env.timers.fire(0);
    await flush();
  }

  it("skips the gateway call when the journal announces landed writes", async () => {
    const ingest = { reported: [] as unknown[][], announces: true };
    const env = harness(landed, ingest);
    await writeThroughCycle(env);

    expect(ingest.reported).toEqual([[{ op: "put", path: "note.md", etag: "ETAG-2", size: 5 }]]);
    // The Vault's Sync Publisher is the announcer now; this cycle sends nothing.
    expect(env.notified).toEqual([]);
  });

  it("still notifies the gateway in legacy mode, where the journal is off", async () => {
    const ingest = { reported: [] as unknown[][], announces: false };
    const env = harness(landed, ingest);
    await writeThroughCycle(env);

    expect(ingest.reported).toEqual([[{ op: "put", path: "note.md", etag: "ETAG-2", size: 5 }]]);
    // In legacy mode the Gateway is still this device's announcer, so the cycle's own hint goes out.
    expect(env.notified).toEqual([[{ op: "put", path: "note.md", etag: "ETAG-2", size: 5 }]]);
  });

  it("keeps the gateway call when no journal is wired at all", async () => {
    const env = harness(landed);
    await writeThroughCycle(env);

    expect(env.notified).toEqual([[{ op: "put", path: "note.md", etag: "ETAG-2", size: 5 }]]);
  });
});
