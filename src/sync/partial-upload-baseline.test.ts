import { describe, expect, it } from "vitest";
import { SafeExecutor } from "./executor";
import { buildSyncPlan } from "./planner";
import type { R2Client } from "../remote/r2-client";
import type { StateStore } from "../state/sync-state";
import type { LocalEntry, PreviousEntry, RemoteEntry, SyncOperation } from "./types";

/**
 * Investigation reproduction for the self-inflicted `both-modified` conflict.
 *
 * A conditional PUT that lands on R2 but whose local file moved on during the write returns
 * `partial` and commits **no** baseline at all. The device consequently keeps the ANCESTOR as its
 * baseline, so its own just-uploaded version reads as an external remote change on the next cycle.
 */

const identity = { endpoint: "https://r2.example", bucket: "test", remotePrefix: "" };

function state(): StateStore & { entries: PreviousEntry[] } {
  const entries: PreviousEntry[] = [];
  return {
    entries,
    loadAll: async () => new Map(entries.map((entry) => [entry.key, entry])),
    saveAll: async () => {},
    saveVerified: async () => {},
    put: async (entry) => { entries.push(entry); },
    delete: async () => {},
  };
}

describe("a landed upload that abandons its baseline", () => {
  it("leaves the ancestor as the baseline and turns the device's own upload into a conflict", async () => {
    // The file as the scan saw it, and the bytes that the conditional PUT actually sends.
    const uploaded: LocalEntry = { key: "daily/note.md", size: 124, mtime: 1790094547566 };
    const base: PreviousEntry = { key: "daily/note.md", local: uploaded, remote: { size: 124, etag: "095fa8ae" }, syncedAt: 1790094548736 };
    let moved = false;
    let reads = 0;

    const file = { path: "daily/note.md" };
    const vault = {
      getFileByPath: () => file,
      getAbstractFileByPath: () => file,
      readBinary: async () => new Uint8Array(142).buffer,
      modifyBinary: async () => {},
      createBinary: async () => {},
      createFolder: async () => ({ path: "" }),
      // Once the PUT is in flight the editor keeps saving, so every later stat reports a newer mtime.
      adapter: { stat: async () => (moved ? { size: 211, mtime: 1790094560058 - reads++ } : { size: 124, mtime: uploaded.mtime }) },
    };

    const saved = state();
    const client = { putObject: async (_key: string, _body: ArrayBuffer) => { moved = true; return { size: 142, etag: "7c3652b5" }; } } as unknown as R2Client;
    const operation: Extract<SyncOperation, { type: "upload" }> = { type: "upload", key: "daily/note.md", reason: "local changed", expectedLocal: uploaded, expectedRemote: { kind: "etag", value: "095fa8ae" } };

    const result = await new SafeExecutor(vault as never, client, saved, identity, "[]").execute(operation);

    // R2 now holds this device's bytes — and the announced generation told every other device so.
    expect(result).toEqual({ status: "partial", key: "daily/note.md", reason: "remote-applied-local-changed" });
    // ...but nothing was committed, so the baseline still names the ancestor 095fa8ae.
    expect(saved.entries).toEqual([]);

    // The next cycle compares: local moved on, and the remote is no longer the baseline either.
    const here: LocalEntry = { key: "daily/note.md", size: 211, mtime: 1790094560058 };
    const there: RemoteEntry = { key: "daily/note.md", size: 142, etag: "7c3652b5", lastModified: 1790094554470 };
    const planned = buildSyncPlan(new Map([[here.key, here]]), new Map([[there.key, there]]), new Map([[base.key, base]]));
    expect(planned.operations).toEqual([{ type: "conflict", key: "daily/note.md", reason: "both sides changed since previous successful sync", conflict: "both-modified" }]);

    // Had the baseline been advanced to the version the PUT actually carried — the local version that
    // was uploaded, paired with the ETag it produced — the same observations plan a plain upload.
    const truthful: PreviousEntry = { key: "daily/note.md", local: uploaded, remote: { size: 142, etag: "7c3652b5" }, syncedAt: 1790094554470 };
    const plannedWithBase = buildSyncPlan(new Map([[here.key, here]]), new Map([[there.key, there]]), new Map([[truthful.key, truthful]]));
    expect(plannedWithBase.operations).toEqual([{ type: "upload", key: "daily/note.md", reason: "local changed since previous successful sync", expectedLocal: here, expectedRemote: { kind: "etag", value: "7c3652b5" } }]);
  });
});

describe("a download that commits whatever the post-write stat happens to say", () => {
  it("records the user's racing save as if it matched the remote version, hiding the edit forever", async () => {
    const file = { path: "a.md" };
    let stored = { bytes: new Uint8Array([1, 2, 3]).buffer, mtime: 10 };
    const vault = {
      getFileByPath: () => file,
      getAbstractFileByPath: () => file,
      readBinary: async () => stored.bytes,
      modifyBinary: async (_file: unknown, value: ArrayBuffer) => {
        // The remote bytes land ...
        stored = { bytes: value, mtime: 20 };
        // ... and the editor's pending save overwrites them before the executor stats the file.
        stored = { bytes: new Uint8Array([9, 9, 9]).buffer, mtime: 30 };
      },
      createBinary: async () => {},
      createFolder: async () => ({ path: "" }),
      adapter: { stat: async () => ({ size: stored.bytes.byteLength, mtime: stored.mtime }) },
    };
    const client = { getObject: async () => new Uint8Array([7, 8]).buffer } as unknown as R2Client;
    const saved = state();
    const operation: Extract<SyncOperation, { type: "download" }> = {
      type: "download",
      key: "a.md",
      reason: "remote changed",
      expectedLocal: { key: "a.md", size: 3, mtime: 10 },
      expectedRemote: { key: "a.md", size: 2, etag: "R", lastModified: 1 },
    };

    const result = await new SafeExecutor(vault as never, client, saved, identity, "[]").execute(operation);

    expect(result).toMatchObject({ status: "applied" });
    // The baseline claims the local version (size 3, mtime 30) is the remote object with ETag "R" —
    // but those bytes are the user's, not the downloaded ones.
    expect(saved.entries).toMatchObject([{ key: "a.md", local: { size: 3, mtime: 30 }, remote: { size: 2, etag: "R" } }]);

    // Nothing is left to notice: the planner now calls this path converged ...
    const plan = buildSyncPlan(
      new Map([["a.md", { key: "a.md", size: 3, mtime: 30 }]]),
      new Map([["a.md", { key: "a.md", size: 2, etag: "R", lastModified: 1 }]]),
      new Map([["a.md", saved.entries[0]]]),
    );
    expect(plan.operations).toEqual([{ type: "noop", key: "a.md", reason: "unchanged since previous successful sync" }]);
    // ... while R2 still holds the downloaded bytes and never receives the user's.
    expect(stored.bytes.byteLength).toBe(3);
  });
});
