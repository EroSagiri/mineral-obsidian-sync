import { describe, expect, it } from "vitest";
import { SyncScheduler } from "./scheduler";
import type { CycleDependencies, SchedulerRemoteChange, SchedulerTimers } from "./types";
import type { LocalEntry, PreviousEntry, RemoteEntry, SyncOperation } from "../sync/types";
import type { RemoteChange } from "@mineral/sync-core/sync-change";

/**
 * Investigation reproductions for the incremental remote-apply window.
 *
 * These pin down what a cycle may report as `confirmed` — and therefore retire as a Gateway
 * generation — when the remote change it was meant to apply did not reach the Vault.
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

function fakeRemote(canApplyIncrementally: (generation: string) => boolean) {
  const confirmed: string[] = [];
  let pending = true;
  let generation = "81";
  const remote: SchedulerRemoteChange = {
    hasPending: () => pending,
    readGeneration: async () => ({ ok: true, generation }),
    confirmReconciled: async (value) => { confirmed.push(value); pending = false; generation = value; },
    notifyRemoteDirty: async () => ({ ok: true, generation }),
    canApplyIncrementally,
  };
  return { remote, confirmed };
}

describe("incremental remote-apply window", () => {
  it("does not confirm a pending generation from a local-only incremental window", async () => {
    const timers = new FakeTimers();
    const { remote, confirmed } = fakeRemote(() => true);
    const observedLocally: string[][] = [];
    let fullRemoteScans = 0;

    const cycle = (): CycleDependencies => ({
      scanLocal: () => new Map<string, LocalEntry>(),
      scanRemote: async () => { fullRemoteScans++; return new Map<string, RemoteEntry>(); },
      loadPrevious: async () => new Map<string, PreviousEntry>(),
      filterPrevious: (entries) => entries,
      localIncrementalObservations: async (keys: string[]) => {
        observedLocally.push(keys);
        return { local: new Map([["local-note.md", { key: "local-note.md", size: 1, mtime: 1 }]]), remote: new Map(), previous: new Map() };
      },
      buildPlan: () => ({ operations: [] as SyncOperation[] }),
      execute: async (operation: SyncOperation) => ({ status: "applied", key: operation.key }),
    });

    const scheduler = new SyncScheduler({ captureCycle: cycle, visible: () => true, timers, remoteChange: remote });

    // A Gateway announcement carrying a remote delta, then a local edit that takes over the debounce.
    scheduler.requestRemoteChange("81", [{ op: "put", path: "remote-note.md" }]);
    scheduler.markLocalPaths(["local-note.md"], () => false);
    timers.fire(1200);
    await flush();

    // A one-path local window cannot cover generation 81, so it must not retire it.
    expect(observedLocally).toEqual([["local-note.md"]]);
    expect(confirmed).toEqual([]);
    expect(scheduler.diagnostics().lastConfirmation).toBe("not-requested");
    // The delta is still queued, but nothing is scheduled to drain it: the only cycle that can consume
    // it is one whose reason is exactly `remote-change`, and no timer was left for that.
    expect(timers.delays()).toEqual([]);
    expect(fullRemoteScans).toBe(0);

    // A fresh announcement is what finally drains it.
    scheduler.requestRemoteChange("81", [{ op: "put", path: "remote-note.md" }]);
    expect(timers.delays()).toEqual([0]);
  });

  it("confirms an incrementally applied generation even when the only operation failed locally", async () => {
    const timers = new FakeTimers();
    const { remote, confirmed } = fakeRemote(() => true);

    const localEntry: LocalEntry = { key: "note.md", size: 5, mtime: 10 };
    const remoteEntry: RemoteEntry = { key: "note.md", size: 9, etag: "etag-2", lastModified: 20 };
    const previous: PreviousEntry = { key: "note.md", local: { size: 5, mtime: 10 }, remote: { size: 5, etag: "etag-1" }, syncedAt: 1 };

    const cycle = (): CycleDependencies => ({
      scanLocal: () => new Map([[localEntry.key, localEntry]]),
      scanRemote: async () => new Map([[remoteEntry.key, remoteEntry]]),
      loadPrevious: async () => new Map([[previous.key, previous]]),
      filterPrevious: (entries) => entries,
      incrementalObservations: async () => ({ local: new Map([[localEntry.key, localEntry]]), remote: new Map([[remoteEntry.key, remoteEntry]]), previous: new Map([[previous.key, previous]]) }),
      buildPlan: () => ({ operations: [{ type: "download", key: "note.md", reason: "remote changed", expectedLocal: localEntry, expectedRemote: remoteEntry }] as SyncOperation[] }),
      // `SafeExecutor.download` returns exactly this when the Vault write landed but the post-write
      // `adapter.stat` did not produce a file: no baseline is committed for the new remote version.
      execute: async (operation: SyncOperation) => ({ status: "failed", key: operation.key, error: "Vault write did not produce a file" }),
    });

    const scheduler = new SyncScheduler({ captureCycle: cycle, visible: () => true, timers, remoteChange: remote });
    scheduler.requestRemoteChange("81", [{ op: "put", path: "note.md" }]);
    timers.fire(0);
    await flush();

    // The failure is local, the remote observation was complete, so the generation is retired and the
    // delta is dropped — while the path's baseline still names the OLD remote version.
    expect(scheduler.diagnostics().lastResultCounts.failed).toBe(1);
    expect(confirmed).toEqual(["81"]);
    expect(scheduler.diagnostics().lastConfirmation).toBe("confirmed");
    expect(timers.delays()).toEqual([]);
  });
});
