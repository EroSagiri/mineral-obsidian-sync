import { describe, expect, it } from "vitest";
import { RemoteHttpError } from "../remote/errors";
import { scanRemote } from "../remote/scan-remote";
import type { R2Client } from "../remote/r2-client";
import type { VaultPathFilter } from "../sync/ignore";
import { observeRemoteDelta } from "../sync/remote-delta";
import type { LocalEntry, PreviousEntry, RemoteEntry } from "../sync/types";
import { conflictIdFor } from "./identity";

/**
 * Conflict identity has to be a property of the disagreement, not of how it was noticed.
 *
 * The same remote deletion reaches the planner two ways: as a Gateway delta answered by one exact HEAD,
 * and as a tombstone folded in by a full scan. If those two observations differ in any field the identity
 * is derived from, the user's pending decision silently stops matching the moment the observation mode
 * changes — they would resolve a conflict, and watch it come back on the next foreground resume.
 *
 * The identity is also what makes a stale decision impossible, so the other direction is pinned here too:
 * a different baseline, or a different local version, must produce a different identity.
 */

const filter: VaultPathFilter = { ignores: () => false } as VaultPathFilter;
const LOCAL: LocalEntry = { key: "note.md", size: 5, mtime: 10 };
const PREVIOUS: PreviousEntry = { key: "note.md", local: { size: 5, mtime: 10 }, remote: { size: 5, etag: "E" }, syncedAt: 1 };

const idFor = (observedRemote: RemoteEntry | undefined, previous: PreviousEntry = PREVIOUS): Promise<string> =>
  conflictIdFor({ channel: "channel-1", path: "note.md", previous, observedLocal: LOCAL, observedRemote });

/** The deletion as a full scan sees it: a tombstone read from the metadata namespace. */
async function fromFullScan(): Promise<RemoteEntry> {
  const client: R2Client = {
    listObjects: async () => [{ key: "note.md", size: 5, etag: "E", lastModified: 1_000 }],
    listTombstones: async () => [{ tombstone: { protocol: 1, path: "note.md", deletedRemoteETag: "E", createdAt: "2026-09-22T00:00:00.000Z" } }],
    headObject: async () => { throw new Error("a full scan does not head"); },
    getObject: async () => { throw new Error("unused"); },
    putObject: async () => { throw new Error("a scan does not write"); },
  };
  return (await scanRemote(client, filter)).get("note.md")!;
}

/** The deletion as a Gateway delta sees it: one HEAD answering for one path. */
async function fromDelta(): Promise<RemoteEntry> {
  const client: R2Client = {
    listObjects: async () => { throw new Error("a delta must never list objects"); },
    listTombstones: async () => { throw new Error("a delta must never list tombstones"); },
    headObject: async (key: string) => ({ key, size: 5, etag: "E", lastModified: 1_000 }),
    getObject: async () => { throw new Error("unused"); },
    putObject: async () => { throw new Error("a delta does not write"); },
  };
  const observed = await observeRemoteDelta([{ op: "delete", path: "note.md" }], {
    client, ignores: () => false, loadPrevious: async () => new Map([["note.md", PREVIOUS]]), statLocal: async () => null, acceptsBaseline: () => true,
  });
  return observed.remote.get("note.md")!;
}

describe("a deletion has one identity whichever way it was observed", () => {
  it("agrees between a Gateway delta and a full scan", async () => {
    const [scanned, delta] = await Promise.all([fromFullScan(), fromDelta()]);

    // The observations are not identical objects — only the facts the identity is built from have to agree.
    expect(scanned.deleted).toMatchObject({ deletedRemoteETag: "E", objectPresent: true });
    expect(delta.deleted).toMatchObject({ deletedRemoteETag: "E", objectPresent: true });
    await expect(idFor(delta)).resolves.toBe(await idFor(scanned));
  });

  it("also agrees when the bytes are physically gone and no version can be named", async () => {
    const client: R2Client = {
      listObjects: async () => [],
      listTombstones: async () => [],
      headObject: async () => { throw new RemoteHttpError("HeadObject", 404); },
      getObject: async () => { throw new Error("unused"); },
      putObject: async () => { throw new Error("a scan does not write"); },
    };
    const observed = await observeRemoteDelta([{ op: "delete", path: "note.md" }], {
      client, ignores: () => false, loadPrevious: async () => new Map([["note.md", PREVIOUS]]), statLocal: async () => null, acceptsBaseline: () => true,
    });

    // There is no tombstone and no object, so this is an absence: the identity must still be a deletion's
    // identity rather than accidentally reading as some live remote version.
    await expect(idFor(observed.remote.get("note.md"))).resolves.toBe(await idFor(undefined));
  });
});

describe("what must change a conflict identity", () => {
  it("changes when the local version moves on", async () => {
    const first = await idFor(undefined);
    const second = await conflictIdFor({ channel: "channel-1", path: "note.md", previous: PREVIOUS, observedLocal: { key: "note.md", size: 9, mtime: 99 } });
    expect(second).not.toBe(first);
  });

  it("changes when the baseline moves, so a re-deletion is a new decision", async () => {
    const first = await idFor(undefined);
    // The note was revived and synced again (a new baseline), then deleted a second time. The pending
    // decision from the first deletion must not be reusable for the second.
    const revived: PreviousEntry = { key: "note.md", local: { size: 5, mtime: 20 }, remote: { size: 5, etag: "E2" }, syncedAt: 2 };
    const second = await conflictIdFor({ channel: "channel-1", path: "note.md", previous: revived, observedLocal: LOCAL });
    expect(second).not.toBe(first);
  });

  it("does not need the named deleted version, because the baseline already distinguishes a re-deletion", async () => {
    // Two deletions of the same path against the *same* baseline are the same disagreement, whichever
    // version each named — the remote advanced and was then deleted, and both of the user's decisions mean
    // the same thing for both. What must never be reusable across deletions is the baseline, which the
    // test above pins; the executor re-reads the current deletion identity when it applies a decision, so
    // the version that is written is always the one that is actually there now.
    const named = (deletedRemoteETag: string): RemoteEntry => ({ key: "note.md", size: 0, lastModified: 1_000, deleted: { path: "note.md", deletedRemoteETag, createdAt: "2026-09-22T00:00:00.000Z", objectPresent: true } });
    expect(await idFor(named("F"))).toBe(await idFor(named("E")));
  });
});
