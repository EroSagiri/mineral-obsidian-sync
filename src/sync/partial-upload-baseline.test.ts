import { describe, expect, it } from "vitest";
import { SafeExecutor } from "./executor";
import { buildSyncPlan } from "./planner";
import type { R2Client } from "../remote/r2-client";
import type { StateStore } from "../state/sync-state";
import type { LocalEntry, PreviousEntry, RemoteEntry, SyncOperation } from "./types";

/**
 * Baseline fidelity on the two transfer paths.
 *
 * A landed conditional PUT must leave a baseline describing the version it carried, and a download must
 * prove the bytes on disk before it claims `local == remote`. Both were reproduced as defects before
 * the fix; both now assert the fixed behaviour.
 */

const identity = { endpoint: "https://r2.example", bucket: "test", remotePrefix: "" };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (values: number[]) => new Uint8Array(values).buffer;
const sizeOf = (text: string) => encoder.encode(text).byteLength;

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

function mergeBases() {
  const recorded: Array<{ path: string; remoteETag?: string; size: number; mtime: number }> = [];
  return {
    recorded,
    recorder: {
      record: async ({ path, baseline }: { path: string; baseline: { localVersion: LocalEntry; remoteETag?: string } }) => {
        recorded.push({ path, remoteETag: baseline.remoteETag, size: baseline.localVersion.size, mtime: baseline.localVersion.mtime });
      },
    },
  };
}

/**
 * A one-file Vault whose metadata and bytes a test can move at exact points, so each scenario can say
 * precisely what the editor did and when.
 */
function vaultFile(initial: { text: string; mtime: number }) {
  const file = { path: "note.md" };
  const stored = { text: initial.text, mtime: initial.mtime };
  const behaviour = {
    /** Every `stat` reports a newer mtime, as a file being typed into continuously would. */
    driftingStats: false,
    /** Reports no metadata at all from the first `stat` after a write. */
    statsUnavailableAfterWrite: false,
    statsUnavailable: false,
    /** What the local write actually leaves behind, instead of the bytes it was handed. */
    onWrite: undefined as undefined | ((value: ArrayBuffer) => void),
    writeThrows: undefined as undefined | Error,
  };
  let drift = 0;
  let wrote = false;
  const write = (value: ArrayBuffer): void => {
    if (behaviour.writeThrows) throw behaviour.writeThrows;
    if (behaviour.onWrite) behaviour.onWrite(value);
    else stored.text = decoder.decode(new Uint8Array(value));
    stored.mtime += 1;
    wrote = true;
  };
  return {
    stored,
    behaviour,
    /** An editor save: newer bytes and a newer timestamp, without going through the Vault. */
    edit(text: string, mtime: number) { stored.text = text; stored.mtime = mtime; },
    asVault: {
      getFileByPath: () => file,
      getAbstractFileByPath: () => file,
      readBinary: async () => bytes([...encoder.encode(stored.text)]),
      modifyBinary: async (_file: unknown, value: ArrayBuffer) => write(value),
      createBinary: async (_key: string, value: ArrayBuffer) => write(value),
      createFolder: async () => ({ path: "" }),
      adapter: {
        stat: async () => {
          if (behaviour.statsUnavailable) return null;
          if (behaviour.statsUnavailableAfterWrite && wrote) return null;
          if (behaviour.driftingStats) return { size: sizeOf(stored.text), mtime: stored.mtime + drift++ };
          return { size: sizeOf(stored.text), mtime: stored.mtime };
        },
      },
    },
  };
}

describe("upload: a landed PUT always leaves a floor baseline", () => {
  /** "base\n" is five bytes, so both transfer paths can share one fixture shape. */
  const UPLOADED: LocalEntry = { key: "note.md", size: 5, mtime: 100 };
  const upload = (): Extract<SyncOperation, { type: "upload" }> => ({ type: "upload", key: "note.md", reason: "local changed", expectedLocal: UPLOADED, expectedRemote: { kind: "etag", value: "ETAG-OLD" } });

  it("keeps the floor baseline when the catch-up cannot complete, so the next plan uploads", async () => {
    const editor = vaultFile({ text: "base\n", mtime: 100 });
    const saved = state();
    const base = mergeBases();
    let puts = 0;
    const client = {
      putObject: async () => {
        puts += 1;
        // The PUT carries the scanned version; the user keeps typing, so no later read is stable.
        editor.edit("base\nB\n", 200);
        editor.behaviour.driftingStats = true;
        return { size: 5, etag: "ETAG-A" };
      },
    } as unknown as R2Client;

    const result = await new SafeExecutor(editor.asVault as never, client, saved, identity, "[]", undefined, base.recorder).execute(upload());

    // The catch-up could not establish a stable local version, so the transfer is not converged ...
    expect(result).toEqual({ status: "partial", key: "note.md", reason: "remote-applied-local-changed" });
    expect(puts).toBe(1);
    // ... but the PUT that did land is recorded as exactly the pair it proved.
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0]).toMatchObject({ key: "note.md", local: { size: 5, mtime: 100 }, remote: { size: 5, etag: "ETAG-A" } });
    // The merge base describes the bytes that were actually uploaded, not whatever is on disk now.
    expect(base.recorded).toEqual([{ path: "note.md", remoteETag: "ETAG-A", size: 5, mtime: 100 }]);

    // The device's own upload must never read back as a remote concurrent edit.
    const here: LocalEntry = { key: "note.md", size: 7, mtime: 200 };
    const there: RemoteEntry = { key: "note.md", size: 5, etag: "ETAG-A", lastModified: 1 };
    const plan = buildSyncPlan(new Map([[here.key, here]]), new Map([[there.key, there]]), new Map([[saved.entries[0]!.key, saved.entries[0]!]]));
    expect(plan.operations).toEqual([{ type: "upload", key: "note.md", reason: "local changed since previous successful sync", expectedLocal: here, expectedRemote: { kind: "etag", value: "ETAG-A" } }]);
  });

  it("records the catch-up's own pair when the local moves on again, so the device cannot conflict with itself", async () => {
    // The reported incident: the first PUT landed, the catch-up PUT landed too, and only then did the
    // editor save again. The catch-up's pair is what R2 holds, so keeping the earlier floor as the
    // baseline made the next cycle read this device's own upload as a remote concurrent edit.
    const editor = vaultFile({ text: "base\n", mtime: 100 });
    const saved = state();
    const base = mergeBases();
    const bodies: string[] = [];
    const client = {
      putObject: async (_key: string, body: ArrayBuffer, options: unknown) => {
        bodies.push(decoder.decode(new Uint8Array(body)));
        if (bodies.length === 1) { editor.edit("base\nB\n", 200); return { size: 5, etag: "ETAG-A" }; }
        expect(options).toEqual({ ifMatch: "ETAG-A" });
        // The catch-up's own PUT lands, and the editor saves once more while it is in flight.
        editor.edit("base\nB\nC\n", 300);
        return { size: 7, etag: "ETAG-B" };
      },
    } as unknown as R2Client;

    const result = await new SafeExecutor(editor.asVault as never, client, saved, identity, "[]", undefined, base.recorder).execute(upload());

    expect(result).toEqual({ status: "partial", key: "note.md", reason: "remote-applied-local-changed" });
    expect(bodies).toEqual(["base\n", "base\nB\n"]);
    // Both landed transfers are recorded, newest last: the catch-up's pair must not be lost.
    expect(saved.entries).toHaveLength(2);
    expect(saved.entries[1]).toMatchObject({ local: { size: 7, mtime: 200 }, remote: { size: 7, etag: "ETAG-B" } });

    const here: LocalEntry = { key: "note.md", size: 9, mtime: 300 };
    const there: RemoteEntry = { key: "note.md", size: 7, etag: "ETAG-B", lastModified: 1 };
    // With the catch-up's pair recorded, the same observations plan a plain upload ...
    expect(buildSyncPlan(new Map([[here.key, here]]), new Map([[there.key, there]]), new Map([[saved.entries[1]!.key, saved.entries[1]!]])).operations)
      .toEqual([{ type: "upload", key: "note.md", reason: "local changed since previous successful sync", expectedLocal: here, expectedRemote: { kind: "etag", value: "ETAG-B" } }]);
    // ... whereas the earlier floor, which is what a missing catch-up baseline leaves behind, conflicts.
    expect(buildSyncPlan(new Map([[here.key, here]]), new Map([[there.key, there]]), new Map([[saved.entries[0]!.key, saved.entries[0]!]])).operations)
      .toEqual([{ type: "conflict", key: "note.md", reason: "both sides changed since previous successful sync", conflict: "both-modified" }]);
  });

  it("would have raised a self-conflict without the floor baseline", async () => {
    // The counterfactual this fix removes: the ancestor as the baseline, the remote already advanced to
    // this device's own bytes, and a local version newer than both.
    const ancestor: PreviousEntry = { key: "note.md", local: { size: 5, mtime: 100 }, remote: { size: 5, etag: "ETAG-OLD" }, syncedAt: 1 };
    const here: LocalEntry = { key: "note.md", size: 7, mtime: 200 };
    const there: RemoteEntry = { key: "note.md", size: 5, etag: "ETAG-A", lastModified: 1 };
    const plan = buildSyncPlan(new Map([[here.key, here]]), new Map([[there.key, there]]), new Map([[ancestor.key, ancestor]]));
    expect(plan.operations).toEqual([{ type: "conflict", key: "note.md", reason: "both sides changed since previous successful sync", conflict: "both-modified" }]);
  });

  it("upgrades the floor baseline when the catch-up lands", async () => {
    const editor = vaultFile({ text: "base\n", mtime: 100 });
    const saved = state();
    const base = mergeBases();
    const bodies: string[] = [];
    const client = {
      putObject: async (_key: string, body: ArrayBuffer, options: unknown) => {
        bodies.push(decoder.decode(new Uint8Array(body)));
        if (bodies.length === 1) { editor.edit("base\nB\n", 200); return { size: 5, etag: "ETAG-A" }; }
        expect(options).toEqual({ ifMatch: "ETAG-A" });
        return { size: 7, etag: "ETAG-B" };
      },
    } as unknown as R2Client;

    const result = await new SafeExecutor(editor.asVault as never, client, saved, identity, "[]", undefined, base.recorder).execute(upload());

    expect(result).toEqual({ status: "applied", key: "note.md" });
    expect(bodies).toEqual(["base\n", "base\nB\n"]);
    // The baseline must end on the newer pair, not stay behind on the floor.
    expect(saved.entries).toHaveLength(2);
    expect(saved.entries[1]).toMatchObject({ local: { size: 7, mtime: 200 }, remote: { size: 7, etag: "ETAG-B" } });
    expect(base.recorded.at(-1)).toMatchObject({ remoteETag: "ETAG-B", size: 7, mtime: 200 });

    const here: LocalEntry = { key: "note.md", size: 7, mtime: 200 };
    const there: RemoteEntry = { key: "note.md", size: 7, etag: "ETAG-B", lastModified: 1 };
    const plan = buildSyncPlan(new Map([[here.key, here]]), new Map([[there.key, there]]), new Map([[saved.entries[1]!.key, saved.entries[1]!]]));
    expect(plan.operations).toEqual([{ type: "noop", key: "note.md", reason: "unchanged since previous successful sync" }]);
  });

  it("leaves no baseline at all when the PUT itself never landed", async () => {
    const editor = vaultFile({ text: "base\n", mtime: 100 });
    const saved = state();
    const client = { putObject: async () => { throw new Error("no response"); } } as unknown as R2Client;

    await expect(new SafeExecutor(editor.asVault as never, client, saved, identity, "[]").execute(upload())).resolves.toEqual({ status: "unresolved", key: "note.md", reason: "ambiguous-put" });
    expect(saved.entries).toHaveLength(0);
  });
});

describe("download: the baseline is only committed for verified bytes", () => {
  const EXPECTED_LOCAL: LocalEntry = { key: "note.md", size: 5, mtime: 100 };
  const REMOTE: RemoteEntry = { key: "note.md", size: 5, etag: "ETAG-R", lastModified: 1 };
  const download = (): Extract<SyncOperation, { type: "download" }> => ({ type: "download", key: "note.md", reason: "remote changed", expectedLocal: EXPECTED_LOCAL, expectedRemote: REMOTE });
  const remoteBody = () => bytes([...encoder.encode("remot")]);
  const client = { getObject: async () => remoteBody() } as unknown as R2Client;

  it("reports partial and commits nothing when an editor save wins the write", async () => {
    const editor = vaultFile({ text: "base\n", mtime: 100 });
    const saved = state();
    const base = mergeBases();
    // The remote bytes land, then the editor's pending save overwrites them before the re-read.
    editor.behaviour.onWrite = () => { editor.edit("base\nUSER\n", 300); };

    const result = await new SafeExecutor(editor.asVault as never, client, saved, identity, "[]", undefined, base.recorder).execute(download());

    expect(result).toEqual({ status: "partial", key: "note.md", reason: "remote-write-raced-with-local-edit" });
    // In particular, the user's content is never recorded as equal to the remote version.
    expect(saved.entries).toHaveLength(0);
    expect(base.recorded).toHaveLength(0);

    // The defect this replaces: binding the racing save to the remote ETag made the planner report the
    // path converged forever, so the user's text could never be uploaded.
    const racy: PreviousEntry = { key: "note.md", local: { size: 10, mtime: 300 }, remote: { size: 5, etag: "ETAG-R" }, syncedAt: 1 };
    const here: LocalEntry = { key: "note.md", size: 10, mtime: 300 };
    const racyPlan = buildSyncPlan(new Map([[here.key, here]]), new Map([[REMOTE.key, REMOTE]]), new Map([[racy.key, racy]]));
    expect(racyPlan.operations).toEqual([{ type: "noop", key: "note.md", reason: "unchanged since previous successful sync" }]);
  });

  it("detects the race by content, not by size or mtime", async () => {
    const editor = vaultFile({ text: "base\n", mtime: 100 });
    const saved = state();
    // Same length as the downloaded bytes and a timestamp that never moves: only a content comparison
    // can tell that the file does not hold what was downloaded.
    editor.behaviour.onWrite = () => { editor.stored.text = "XXXXX"; };
    editor.behaviour.driftingStats = false;
    const asVault = { ...editor.asVault, adapter: { stat: async () => ({ size: 5, mtime: 100 }) } };

    const result = await new SafeExecutor(asVault as never, client, saved, identity, "[]").execute(download());

    expect(result).toEqual({ status: "partial", key: "note.md", reason: "remote-write-raced-with-local-edit" });
    expect(saved.entries).toHaveLength(0);
  });

  it("commits the verified version and records its merge base when the write landed", async () => {
    const editor = vaultFile({ text: "base\n", mtime: 100 });
    const saved = state();
    const base = mergeBases();

    const result = await new SafeExecutor(editor.asVault as never, client, saved, identity, "[]", undefined, base.recorder).execute(download());

    expect(result).toMatchObject({ status: "applied", key: "note.md", localWrite: { key: "note.md", size: 5, mtime: 101 } });
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0]).toMatchObject({ local: { size: 5, mtime: 101 }, remote: { size: 5, etag: "ETAG-R" } });
    expect(base.recorded).toEqual([{ path: "note.md", remoteETag: "ETAG-R", size: 5, mtime: 101 }]);
  });

  it("treats an unreadable post-write stat as landing-unknown, never as a definitive failure", async () => {
    const editor = vaultFile({ text: "base\n", mtime: 100 });
    const saved = state();
    editor.behaviour.statsUnavailableAfterWrite = true;

    const result = await new SafeExecutor(editor.asVault as never, client, saved, identity, "[]").execute(download());

    expect(result).toEqual({ status: "partial", key: "note.md", reason: "remote-write-landing-unknown" });
    expect(saved.entries).toHaveLength(0);
  });

  it("treats a throwing local write as landing-unknown, never as a definitive failure", async () => {
    const editor = vaultFile({ text: "base\n", mtime: 100 });
    const saved = state();
    editor.behaviour.writeThrows = new Error("write interrupted");

    const result = await new SafeExecutor(editor.asVault as never, client, saved, identity, "[]").execute(download());

    expect(result).toEqual({ status: "partial", key: "note.md", reason: "remote-write-landing-unknown", error: "write interrupted" });
    expect(saved.entries).toHaveLength(0);
  });

  it("still fails definitively when nothing was written at all", async () => {
    const editor = vaultFile({ text: "base\n", mtime: 100 });
    const saved = state();
    // A folder occupying the target is decided before any write, so it stays a definitive failure.
    const asVault = { ...editor.asVault, getFileByPath: () => null, getAbstractFileByPath: () => ({ path: "note.md" }) };

    const result = await new SafeExecutor(asVault as never, client, saved, identity, "[]").execute(download());

    expect(result).toMatchObject({ status: "failed", reason: "target-path-is-folder" });
    expect(saved.entries).toHaveLength(0);
  });
});
