import { beforeEach, describe, expect, it } from "vitest";
import { installDomParserShim } from "../../test/integration/dom-parser-shim";
import { createFakeVault } from "../../test/integration/fake-vault";
import type { FakeVault } from "../../test/integration/fake-vault";
import { createMemoryConflictStores } from "./stores";
import type { MemoryConflictStores } from "./stores";
import { createMergeBaseRecorder, recordMergeBaseBatch } from "./merge-base";
import { ConflictCoordinator } from "./coordinator";
import { baselineMatches, conflictIdFor, shortConflictId } from "./identity";
import { CONFLICT_PROTOCOL_VERSION, type ConflictRecord, type MergeBaseRecord, type MergeBaseStore } from "./types";
import type { R2Client } from "../remote/r2-client";
import type { LocalEntry, PreviousEntry } from "../sync/types";
import type { Vault } from "obsidian";

const bytes = (text: string): ArrayBuffer => { const encoded = new TextEncoder().encode(text); return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer; };
const text = (buffer: ArrayBuffer): string => new TextDecoder().decode(buffer);

const CHANNEL = "A".repeat(43);
const previous = (key: string, size: number, mtime: number, etag: string): PreviousEntry => ({ key, local: { size, mtime }, remote: { size, etag }, syncedAt: 1 });
const localEntry = (key: string, size: number, mtime: number): LocalEntry => ({ key, size, mtime });

function setup(files: Record<string, string> = {}) {
  const vault = createFakeVault({}, {});
  for (const [path, content] of Object.entries(files)) vault.files.set(path, { bytes: new TextEncoder().encode(content), mtime: 10 });
  const stores = createMemoryConflictStores();
  const reconcilations: number[] = [];
  return { vault, stores, reconcilations };
}

describe("merge base store", () => {
  it("records a snapshot only for converged, mergeable text", async () => {
    const vault = createFakeVault({}, {});
    vault.files.set("note.md", { bytes: new TextEncoder().encode("hello\n"), mtime: 10 });
    vault.files.set("image.png", { bytes: new Uint8Array([1, 2, 3]), mtime: 10 });
    vault.files.set("data.json", { bytes: new TextEncoder().encode("{}\n"), mtime: 10 });
    const stores = createMemoryConflictStores();
    const recorder = createMergeBaseRecorder(vault as unknown as Vault, CHANNEL, stores);

    await recorder.record({ path: "note.md", baseline: { localVersion: localEntry("note.md", 6, 10), remoteETag: "A" } });
    await recorder.record({ path: "image.png", baseline: { localVersion: localEntry("image.png", 3, 10), remoteETag: "B" } });
    await recorder.record({ path: "data.json", baseline: { localVersion: localEntry("data.json", 3, 10), remoteETag: "C" } });

    expect(stores.mergeBase.size).toBe(1);
    const record = stores.mergeBase.get(`${CHANNEL}\u0000note.md`)!;
    expect(record.content).toBe("hello\n");
    expect(record.baseline.remoteETag).toBe("A");
    expect(record.byteLength).toBe(6);
    expect(record.sha256).toHaveLength(64);
  });

  it("does not store a body for an oversized file", async () => {
    const vault = createFakeVault({}, {});
    const big = new Uint8Array(1024 * 1024 + 1);
    vault.files.set("big.md", { bytes: big, mtime: 10 });
    const stores = createMemoryConflictStores();
    await createMergeBaseRecorder(vault as unknown as Vault, CHANNEL, stores).record({ path: "big.md", baseline: { localVersion: localEntry("big.md", big.byteLength, 10) } });
    expect(stores.mergeBase.size).toBe(0);
  });

  it("isolates channels and paths", async () => {
    const vault = createFakeVault({}, {});
    vault.files.set("note.md", { bytes: new TextEncoder().encode("hello\n"), mtime: 10 });
    const stores = createMemoryConflictStores();
    await createMergeBaseRecorder(vault as unknown as Vault, CHANNEL, stores).record({ path: "note.md", baseline: { localVersion: localEntry("note.md", 6, 10) } });
    await createMergeBaseRecorder(vault as unknown as Vault, "B".repeat(43), stores).record({ path: "note.md", baseline: { localVersion: localEntry("note.md", 6, 10) } });
    expect(stores.mergeBase.size).toBe(2);
    expect(await stores.get(CHANNEL, "note.md")).toBeDefined();
    expect(await stores.get(CHANNEL, "other.md")).toBeUndefined();
    expect(await stores.get("C".repeat(43), "note.md")).toBeUndefined();
  });

  it("backfills several missing snapshots with one batch write and one prune", async () => {
    const vault = createFakeVault({}, {});
    vault.files.set("one.md", { bytes: new TextEncoder().encode("one\n"), mtime: 10 });
    vault.files.set("two.md", { bytes: new TextEncoder().encode("two\n"), mtime: 11 });
    const records = new Map<string, MergeBaseRecord>();
    let putManyCalls = 0, pruneCalls = 0;
    const store: MergeBaseStore = {
      get: async () => undefined,
      getMany: async () => new Map(),
      put: async () => undefined,
      putMany: async (batch) => { putManyCalls++; for (const record of batch) records.set(record.path, record); },
      remove: async () => undefined,
      prune: async () => { pruneCalls++; },
    };

    await recordMergeBaseBatch(vault as unknown as Vault, CHANNEL, store, [
      { path: "one.md", baseline: { localVersion: localEntry("one.md", 4, 10), remoteETag: "one" } },
      { path: "two.md", baseline: { localVersion: localEntry("two.md", 4, 11), remoteETag: "two" } },
      { path: "binary.png", baseline: { localVersion: localEntry("binary.png", 1, 12), remoteETag: "skip" } },
    ]);

    expect([...records.keys()].sort()).toEqual(["one.md", "two.md"]);
    expect(putManyCalls).toBe(1);
    expect(pruneCalls).toBe(1);
  });

  it("looks up merge bases in one channel-scoped batch", async () => {
    const stores = createMemoryConflictStores();
    await stores.put({ protocolVersion: CONFLICT_PROTOCOL_VERSION, channel: CHANNEL, path: "one.md", baseline: { localVersion: localEntry("one.md", 1, 1) }, sha256: "a", byteLength: 1, encoding: { bom: false, eol: "lf", trailingNewline: false }, content: "a", updatedAt: 1 });
    const found = await stores.getMany(CHANNEL, ["one.md", "missing.md"]);
    expect([...found.keys()]).toEqual(["one.md"]);
  });

  it("treats a snapshot as void once the baseline has moved", () => {
    const baseline = { localVersion: localEntry("note.md", 6, 10), remoteETag: "A" };
    expect(baselineMatches(baseline, previous("note.md", 6, 10, "A"))).toBe(true);
    expect(baselineMatches(baseline, previous("note.md", 6, 11, "A"))).toBe(false);
    expect(baselineMatches(baseline, previous("note.md", 7, 10, "A"))).toBe(false);
    expect(baselineMatches(baseline, previous("note.md", 6, 10, "B"))).toBe(false);
    expect(baselineMatches(baseline, undefined)).toBe(false);
  });
});

describe("conflict identity", () => {
  it("changes when the local version, the remote ETag, or the baseline changes", async () => {
    const input = { channel: CHANNEL, path: "note.md", previous: previous("note.md", 6, 10, "A"), observedLocal: localEntry("note.md", 7, 20), observedRemote: { key: "note.md", size: 7, etag: "B", lastModified: 1 } };
    const base = await conflictIdFor(input);
    expect(base).toBe(await conflictIdFor(input));
    expect(await conflictIdFor({ ...input, observedLocal: localEntry("note.md", 8, 20) })).not.toBe(base);
    expect(await conflictIdFor({ ...input, observedRemote: { key: "note.md", size: 7, etag: "C", lastModified: 1 } })).not.toBe(base);
    expect(await conflictIdFor({ ...input, previous: previous("note.md", 6, 99, "A") })).not.toBe(base);
    expect(await conflictIdFor({ ...input, channel: "B".repeat(43) })).not.toBe(base);
    expect(shortConflictId(base)).toHaveLength(8);
  });
});

describe("divergence policy through the coordinator", () => {
  let env: ReturnType<typeof setup>;
  let remoteBodies: Map<string, string>;
  let reconcileReasons: string[];

  const client = (): R2Client => ({
    listObjects: async () => [],
    headObject: async () => ({ key: "", size: 0, lastModified: 0 }),
    getObject: async (key: string) => {
      const body = remoteBodies.get(key);
      if (body === undefined) throw new Error("not in remote");
      return bytes(body);
    },
    putObject: async () => ({ size: 0, etag: "new" }),
  });

  const coordinator = () => new ConflictCoordinator({
    vault: env.vault as unknown as Vault,
    client: client(),
    channel: CHANNEL,
    mergeBase: env.stores,
    conflicts: env.stores,
    intents: env.stores,
    requestReconcile: (reason) => { reconcileReasons.push(reason); },
    now: () => 1000,
  });

  /** Records the ancestor for a baseline the way a converged transfer would have. */
  const recordAncestor = async (key: string, content: string, baseline: PreviousEntry, mtime: number): Promise<void> => {
    await env.stores.put({
      protocolVersion: CONFLICT_PROTOCOL_VERSION, channel: CHANNEL, path: key,
      baseline: { localVersion: localEntry(key, new TextEncoder().encode(content).byteLength, mtime), remoteETag: baseline.remote!.etag! },
      sha256: "0".repeat(64), byteLength: new TextEncoder().encode(content).byteLength,
      encoding: { bom: false, eol: "lf", trailingNewline: content.endsWith("\n") }, content, updatedAt: 1,
    });
  };

  const sizeOf = (value: string): number => new TextEncoder().encode(value).byteLength;

  beforeEach(() => { env = setup(); remoteBodies = new Map(); reconcileReasons = []; });

  it("settles a short device handoff, records it as evidence, and proposes the combined text", async () => {
    const ancestor = "windows\nsf\n";
    const mine = "windows\nsf\nfrom windows\n";
    const theirs = "windows\nsf\noppo\n";
    // This device wrote first and the other side picked it up 3.5s later: close enough in time to be a
    // handoff. The order of the two additions comes from their content, not from who wrote first — a
    // time-based order would give each device a different merged text.
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode(mine), mtime: 1_500 });
    remoteBodies.set("note.md", theirs);
    const baseline = previous("note.md", sizeOf(ancestor), 1_000, "A");
    await recordAncestor("note.md", ancestor, baseline, 1_000);

    await coordinator().handleConflicts([{
      key: "note.md", previous: baseline,
      observedLocal: localEntry("note.md", sizeOf(mine), 1_500),
      observedRemote: { key: "note.md", size: sizeOf(theirs), etag: "B", lastModified: 5_000 },
    }]);

    // The planner gets a proposal, not an instruction: nothing here writes anything.
    const intents = await env.stores.listIntents(CHANNEL);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ type: "merged", origin: "auto", path: "note.md" });
    expect(intents[0]!.merged!.content).toBe("windows\nsf\nfrom windows\noppo\n");
    // Recorded, so the history entry can carry the ancestor and both sides ...
    const records = await env.stores.listConflicts(CHANNEL);
    expect(records).toHaveLength(1);
    expect(records[0]!.autoMergeStatus).toBe("handoff");
    expect(records[0]!.handoff).toMatchObject({ branchSeparationMs: 3_500, hunkCount: 1, localDeltaBytes: 13, remoteDeltaBytes: 5, order: "stable-content" });
    expect(records[0]!.snapshot).toMatchObject({ base: ancestor, local: mine, remote: theirs, draft: "windows\nsf\nfrom windows\noppo\n" });
    // ... and a follow-up cycle is scheduled to apply it.
    expect(reconcileReasons).toContain("conflict-auto-merge");
  });

  it("still asks the user when the same shape of change arrived slowly", async () => {
    const ancestor = "windows\nsf\n";
    const mine = "windows\nsf\nfrom windows\n";
    const theirs = "windows\nsf\noppo\n";
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode(mine), mtime: 10_000_000 });
    remoteBodies.set("note.md", theirs);
    const baseline = previous("note.md", sizeOf(ancestor), 1_000, "A");
    await recordAncestor("note.md", ancestor, baseline, 1_000);

    await coordinator().handleConflicts([{
      key: "note.md", previous: baseline,
      observedLocal: localEntry("note.md", sizeOf(mine), 10_000_000),
      observedRemote: { key: "note.md", size: sizeOf(theirs), etag: "B", lastModified: 1_000 },
    }]);

    expect(await env.stores.listIntents(CHANNEL)).toHaveLength(0);
    const records = await env.stores.listConflicts(CHANNEL);
    expect(records[0]).toMatchObject({ autoMergeStatus: "manual-required" });
    expect(records[0]!.reason).toContain("longer than a handoff");
  });

  it("settles a divergence that is only formatting, without consulting time", async () => {
    const ancestor = "a\nb\n";
    const mine = "a\nb \n";
    const theirs = "a\nb\t\n";
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode(mine), mtime: 999_999_999 });
    remoteBodies.set("note.md", theirs);
    const baseline = previous("note.md", sizeOf(ancestor), 1_000, "A");
    await recordAncestor("note.md", ancestor, baseline, 1_000);

    await coordinator().handleConflicts([{
      key: "note.md", previous: baseline,
      observedLocal: localEntry("note.md", sizeOf(mine), 999_999_999),
      observedRemote: { key: "note.md", size: sizeOf(theirs), etag: "B", lastModified: 1_000 },
    }]);

    const records = await env.stores.listConflicts(CHANNEL);
    expect(records[0]).toMatchObject({ autoMergeStatus: "clean" });
    expect(records[0]!.reason).toContain("formatting");
    expect(records[0]!.handoff).toBeUndefined();
  });

  it("keeps a replaced region manual, with the marker draft the resolver can show", async () => {
    const ancestor = "value = A\n";
    const mine = "value = B\n";
    const theirs = "value = C\n";
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode(mine), mtime: 5_000 });
    remoteBodies.set("note.md", theirs);
    const baseline = previous("note.md", sizeOf(ancestor), 1_000, "A");
    await recordAncestor("note.md", ancestor, baseline, 1_000);

    await coordinator().handleConflicts([{
      key: "note.md", previous: baseline,
      observedLocal: localEntry("note.md", sizeOf(mine), 5_000),
      observedRemote: { key: "note.md", size: sizeOf(theirs), etag: "B", lastModified: 1_000 },
    }]);

    expect(await env.stores.listIntents(CHANNEL)).toHaveLength(0);
    const records = await env.stores.listConflicts(CHANNEL);
    expect(records[0]).toMatchObject({ autoMergeStatus: "manual-required" });
    expect(records[0]!.snapshot.draft).toContain("<<<<<<< LOCAL");
  });
});

describe("conflict coordinator", () => {
  let env: ReturnType<typeof setup>;
  let remoteBodies: Map<string, string>;
  let remoteError: Error | undefined;
  let reconcileReasons: string[];

  const client = (): R2Client => ({
    listObjects: async () => [],
    headObject: async () => ({ key: "", size: 0, lastModified: 0 }),
    getObject: async (key: string) => {
      if (remoteError) throw remoteError;
      const body = remoteBodies.get(key);
      if (body === undefined) throw new Error("not in remote");
      return bytes(body);
    },
    putObject: async () => ({ size: 0, etag: "new" }),
  });

  function coordinator(overrides: Partial<{ channel: string }> = {}) {
    return new ConflictCoordinator({
      vault: env.vault as unknown as Vault,
      client: client(),
      channel: overrides.channel ?? CHANNEL,
      mergeBase: env.stores,
      conflicts: env.stores,
      intents: env.stores,
      requestReconcile: (reason) => { reconcileReasons.push(reason); env.reconcilations.push(1); },
      now: () => 1000,
    });
  }

  beforeEach(() => { env = setup(); remoteBodies = new Map(); remoteError = undefined; reconcileReasons = []; });

  it("marks a conflict manual-required when no merge base exists", async () => {
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode("local\n"), mtime: 50 });
    remoteBodies.set("note.md", "remote\n");
    const base = previous("note.md", 6, 10, "A");
    await coordinator().handleConflicts([{ key: "note.md", previous: base, observedLocal: localEntry("note.md", 6, 50), observedRemote: { key: "note.md", size: 7, etag: "B", lastModified: 1 } }]);
    const [record] = await env.stores.listConflicts(CHANNEL);
    expect(record.autoMergeStatus).toBe("base-unavailable");
    expect(record.snapshot.baseAvailable).toBe(false);
    // Crucially: no intent was produced, so nothing can be applied automatically.
    expect(env.stores.intents.size).toBe(0);
  });

  it("does not use a snapshot whose baseline no longer matches", async () => {
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode("local\n"), mtime: 50 });
    remoteBodies.set("note.md", "remote\n");
    const snapshot: MergeBaseRecord = { protocolVersion: CONFLICT_PROTOCOL_VERSION, channel: CHANNEL, path: "note.md", baseline: { localVersion: localEntry("note.md", 6, 999), remoteETag: "OLD" }, sha256: "x", byteLength: 4, encoding: { bom: false, eol: "lf", trailingNewline: true }, content: "base\n", updatedAt: 1 };
    env.stores.mergeBase.set(`${CHANNEL}\u0000note.md`, snapshot);
    await coordinator().handleConflicts([{ key: "note.md", previous: previous("note.md", 6, 10, "A"), observedLocal: localEntry("note.md", 6, 50), observedRemote: { key: "note.md", size: 7, etag: "B", lastModified: 1 } }]);
    const [record] = await env.stores.listConflicts(CHANNEL);
    expect(record.autoMergeStatus).toBe("base-unavailable");
  });

  it("produces a merged intent, not a mutation, for a clean three-way merge", async () => {
    const localText = "A\nB-local\nC\n";
    const remoteText = "A\nB\nC\nD-remote\n";
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode(localText), mtime: 10 });
    remoteBodies.set("note.md", remoteText);
    // The snapshot's baseline must be the baseline in force, and the observed local version must be
    // the version the scan saw (unchanged since the baseline) — that is what makes this a conflict the
    // merge base can actually speak to.
    const snapshot: MergeBaseRecord = { protocolVersion: CONFLICT_PROTOCOL_VERSION, channel: CHANNEL, path: "note.md", baseline: { localVersion: localEntry("note.md", localText.length, 10), remoteETag: "A" }, sha256: "x", byteLength: 6, encoding: { bom: false, eol: "lf", trailingNewline: true }, content: "A\nB\nC\n", updatedAt: 1 };
    env.stores.mergeBase.set(`${CHANNEL}\u0000note.md`, snapshot);
    await coordinator().handleConflicts([{ key: "note.md", previous: previous("note.md", localText.length, 10, "A"), observedLocal: localEntry("note.md", localText.length, 10), observedRemote: { key: "note.md", size: remoteText.length, etag: "B", lastModified: 1 } }]);

    expect(env.stores.intents.size).toBe(1);
    const intent = [...env.stores.intents.values()][0]!;
    expect(intent.type).toBe("merged");
    expect(intent.merged?.content).toBe("A\nB-local\nC\nD-remote\n");
    expect(intent.expectedRemoteETag).toBe("B");
    // The coordinator recorded a proposal and asked for a cycle; it did not touch either side.
    expect(env.reconcilations.length).toBe(1);
    expect(new TextDecoder().decode(env.vault.files.get("note.md")!.bytes)).toBe(localText);
  });

  it("reports manual-required for overlapping edits and still records the conflict", async () => {
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode("value = B\n"), mtime: 50 });
    remoteBodies.set("note.md", "value = C\n");
    const snapshot: MergeBaseRecord = { protocolVersion: CONFLICT_PROTOCOL_VERSION, channel: CHANNEL, path: "note.md", baseline: { localVersion: localEntry("note.md", 10, 10), remoteETag: "A" }, sha256: "x", byteLength: 10, encoding: { bom: false, eol: "lf", trailingNewline: true }, content: "value = A\n", updatedAt: 1 };
    env.stores.mergeBase.set(`${CHANNEL}\u0000note.md`, snapshot);
    await coordinator().handleConflicts([{ key: "note.md", previous: previous("note.md", 10, 10, "A"), observedLocal: localEntry("note.md", 10, 50), observedRemote: { key: "note.md", size: 10, etag: "B", lastModified: 1 } }]);
    const [record] = await env.stores.listConflicts(CHANNEL);
    expect(record.autoMergeStatus).toBe("manual-required");
    expect(record.snapshot.base).toBe("value = A\n");
    expect(record.snapshot.draft).toContain("<<<<<<< LOCAL");
    expect(env.stores.intents.size).toBe(0);
  });

  it("refuses to merge an unsupported file type or an oversized body", async () => {
    for (const [path, content] of [["data.json", "{}\n"], ["a.png", "not-really\n"]]) {
      env = setup();
      env.vault.files.set(path, { bytes: new TextEncoder().encode(content), mtime: 50 });
      remoteBodies.set(path, content);
      await coordinator().handleConflicts([{ key: path, previous: previous(path, content.length, 10, "A"), observedLocal: localEntry(path, content.length, 50), observedRemote: { key: path, size: content.length, etag: "B", lastModified: 1 } }]);
      const [record] = await env.stores.listConflicts(CHANNEL);
      expect(record.autoMergeStatus, path).toBe("unsupported");
      expect(env.stores.intents.size, path).toBe(0);
    }
  });

  it("keeps trying a manual-required conflict out of the loop", async () => {
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode("local\n"), mtime: 50 });
    remoteBodies.set("note.md", "remote\n");
    const instance = coordinator();
    const input = { key: "note.md", previous: previous("note.md", 6, 10, "A"), observedLocal: localEntry("note.md", 6, 50), observedRemote: { key: "note.md", size: 7, etag: "B", lastModified: 1 } };
    await instance.handleConflicts([input]);
    expect(env.reconcilations.length).toBe(1);
    // A second cycle with the same conflict must not propose anything again.
    await instance.handleConflicts([input]);
    expect(env.reconcilations.length).toBe(1);
  });

  it("never records a conflict for a channel-less coordinator", async () => {
    const instance = coordinator({ channel: "" });
    await instance.handleConflicts([{ key: "note.md", previous: previous("note.md", 1, 1, "A") }]);
    expect(env.stores.conflicts.size).toBe(0);
  });

  it("validates an intent against the current observations, not just the path", async () => {
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode("local\n"), mtime: 50 });
    remoteBodies.set("note.md", "remote\n");
    const input = { key: "note.md", previous: previous("note.md", 6, 10, "A"), observedLocal: localEntry("note.md", 6, 50), observedRemote: { key: "note.md", size: 7, etag: "B", lastModified: 1 } };
    const conflictId = await conflictIdFor({ channel: CHANNEL, path: "note.md", previous: input.previous, observedLocal: input.observedLocal, observedRemote: input.observedRemote });
    const instance = coordinator();
    await instance.propose({ protocolVersion: CONFLICT_PROTOCOL_VERSION, conflictId, channel: CHANNEL, path: "note.md", type: "keep-local", expectedLocalVersion: input.observedLocal, expectedRemoteETag: "B", createdAt: 1 });
    await instance.handleConflicts([input]);
    // The intent is valid for these observations.
    expect(instance.resolutions().has("note.md")).toBe(true);

    // Change the local version: the same stored intent is no longer applicable.
    await instance.handleConflicts([{ ...input, observedLocal: localEntry("note.md", 9, 77) }]);
    expect(instance.resolutions().has("note.md")).toBe(false);
  });

  it("drops a conflict once it is no longer active", async () => {
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode("local\n"), mtime: 50 });
    remoteBodies.set("note.md", "remote\n");
    const instance = coordinator();
    await instance.handleConflicts([{ key: "note.md", previous: previous("note.md", 6, 10, "A"), observedLocal: localEntry("note.md", 6, 50), observedRemote: { key: "note.md", size: 7, etag: "B", lastModified: 1 } }]);
    expect(await instance.list()).toHaveLength(1);
    await instance.handleConflicts([]);
    expect(await instance.list()).toHaveLength(0);
  });

  it("survives a remote read failure by staying manual-required", async () => {
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode("local\n"), mtime: 50 });
    remoteError = new Error("network down");
    const snapshot: MergeBaseRecord = { protocolVersion: CONFLICT_PROTOCOL_VERSION, channel: CHANNEL, path: "note.md", baseline: { localVersion: localEntry("note.md", 6, 10), remoteETag: "A" }, sha256: "x", byteLength: 6, encoding: { bom: false, eol: "lf", trailingNewline: true }, content: "base\n", updatedAt: 1 };
    env.stores.mergeBase.set(`${CHANNEL}\u0000note.md`, snapshot);
    await coordinator().handleConflicts([{ key: "note.md", previous: previous("note.md", 6, 10, "A"), observedLocal: localEntry("note.md", 6, 50), observedRemote: { key: "note.md", size: 7, etag: "B", lastModified: 1 } }]);
    const [record] = await env.stores.listConflicts(CHANNEL);
    expect(record.autoMergeStatus).toBe("manual-required");
    expect(env.stores.intents.size).toBe(0);
  });

  it("clears a conflict and its intent together", async () => {
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode("local\n"), mtime: 50 });
    remoteBodies.set("note.md", "remote\n");
    const instance = coordinator();
    await instance.handleConflicts([{ key: "note.md", previous: previous("note.md", 6, 10, "A"), observedLocal: localEntry("note.md", 6, 50), observedRemote: { key: "note.md", size: 7, etag: "B", lastModified: 1 } }]);
    const [record] = await env.stores.listConflicts(CHANNEL);
    await instance.propose({ protocolVersion: CONFLICT_PROTOCOL_VERSION, conflictId: record.conflictId, channel: CHANNEL, path: "note.md", type: "keep-remote", expectedLocalVersion: record.observedLocal, expectedRemoteETag: record.observedRemoteETag, createdAt: 1 });
    await instance.clear(record.conflictId, "note.md");
    expect(env.stores.conflicts.size).toBe(0);
    expect(env.stores.intents.size).toBe(0);
  });

  it("carries no content into conflict observations the scheduler passes around", () => {
    // The observation type is identity inputs only; this guards against content creeping into the
    // scheduler's data flow, which is what keeps logs and diagnostics safe.
    const observation: ConflictRecord["observedLocal"] = localEntry("note.md", 6, 50);
    expect(Object.keys(observation).sort()).toEqual(["key", "mtime", "size"]);
  });

  it("asks for an automatic cycle after an auto-merge, and an immediate one after a user action", async () => {
    const cleanLocal = "A\nB-local\nC\n";
    const cleanRemote = "A\nB\nC\nD-remote\n";
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode(cleanLocal), mtime: 10 });
    remoteBodies.set("note.md", cleanRemote);
    env.stores.mergeBase.set(`${CHANNEL}\u0000note.md`, { protocolVersion: CONFLICT_PROTOCOL_VERSION, channel: CHANNEL, path: "note.md", baseline: { localVersion: localEntry("note.md", cleanLocal.length, 10), remoteETag: "A" }, sha256: "x", byteLength: 6, encoding: { bom: false, eol: "lf", trailingNewline: true }, content: "A\nB\nC\n", updatedAt: 1 });
    const instance = coordinator();
    await instance.handleConflicts([{ key: "note.md", previous: previous("note.md", cleanLocal.length, 10, "A"), observedLocal: localEntry("note.md", cleanLocal.length, 10), observedRemote: { key: "note.md", size: cleanRemote.length, etag: "B", lastModified: 1 } }]);
    // An auto-merge may wait out a debounce.
    expect(reconcileReasons).toEqual(["conflict-auto-merge"]);

    // A user's explicit choice should be applied on the next cycle, not after a delay.
    reconcileReasons = [];
    await instance.propose({ protocolVersion: CONFLICT_PROTOCOL_VERSION, conflictId: "c", channel: CHANNEL, path: "note.md", type: "keep-remote", expectedLocalVersion: localEntry("note.md", 1, 1), createdAt: 1 });
    expect(reconcileReasons).toEqual(["conflict-manual-resolution"]);
  });

  it("schedules a second immediate cycle once a manual intent is validated", async () => {
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode("local\n"), mtime: 50 });
    remoteBodies.set("note.md", "remote\n");
    const input = { key: "note.md", previous: previous("note.md", 6, 10, "A"), observedLocal: localEntry("note.md", 6, 50), observedRemote: { key: "note.md", size: 7, etag: "B", lastModified: 1 } };
    const instance = coordinator();
    await instance.handleConflicts([input]);
    const [record] = await env.stores.listConflicts(CHANNEL);
    reconcileReasons = [];
    await instance.propose({ protocolVersion: CONFLICT_PROTOCOL_VERSION, conflictId: record.conflictId, channel: CHANNEL, path: "note.md", type: "keep-local", expectedLocalVersion: input.observedLocal, expectedRemoteETag: "B", createdAt: 1 });
    await instance.handleConflicts([input]);
    expect(instance.resolutions().get("note.md")?.intent.type).toBe("keep-local");
    expect(reconcileReasons).toEqual(["conflict-manual-resolution", "conflict-manual-resolution"]);
  });

  it("reconciles stored records even when a cycle reports no conflicts at all", async () => {
    // A key that stops conflicting produces no conflict operation, so the empty call is the only signal
    // that a previously recorded conflict is gone. Without it the record would persist indefinitely.
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode("local\n"), mtime: 50 });
    remoteBodies.set("note.md", "remote\n");
    const instance = coordinator();
    await instance.handleConflicts([{ key: "note.md", previous: previous("note.md", 6, 10, "A"), observedLocal: localEntry("note.md", 6, 50), observedRemote: { key: "note.md", size: 7, etag: "B", lastModified: 1 } }]);
    expect(await instance.list()).toHaveLength(1);
    await instance.handleConflicts([]);
    expect(await instance.list()).toHaveLength(0);
    expect(instance.resolutions().size).toBe(0);
  });

  it("never mixes two channels' conflict state", async () => {
    env.vault.files.set("note.md", { bytes: new TextEncoder().encode("local\n"), mtime: 50 });
    remoteBodies.set("note.md", "remote\n");
    const instance = coordinator();
    await instance.handleConflicts([{ key: "note.md", previous: previous("note.md", 6, 10, "A"), observedLocal: localEntry("note.md", 6, 50), observedRemote: { key: "note.md", size: 7, etag: "B", lastModified: 1 } }]);
    expect(await instance.list()).toHaveLength(1);
    // Switching namespace must not carry the previous channel's records, intents, or attempt history.
    instance.setChannel("B".repeat(43));
    expect(await instance.list()).toHaveLength(0);
  });
});
