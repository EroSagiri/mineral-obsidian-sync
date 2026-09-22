import type { Vault } from "obsidian";
import type { MergeBaseRecorder } from "../sync/executor";
import { MAX_MERGEABLE_BYTES, decodeText, isMergeablePath } from "../sync/text";
import { sha256Hex } from "./identity";
import { CONFLICT_PROTOCOL_VERSION, type MergeBaseRecord, type MergeBaseStore } from "./types";

/** Bounded parallel reads avoid stalling an entire reconciliation on hundreds of small files. */
export const MERGE_BASE_RECORD_CONCURRENCY = 4;
export type MergeBaseInput = { path: string; baseline: { localVersion: { key: string; size: number; mtime: number }; remoteETag?: string } };

async function prepareRecord(vault: Vault, channel: string, input: MergeBaseInput, now: () => number): Promise<MergeBaseRecord | undefined> {
  const { path, baseline } = input;
  if (!channel || !isMergeablePath(path)) return undefined;
  const file = vault.getFileByPath(path);
  if (!file) return undefined;
  const before = await vault.adapter.stat(path);
  if (!before || before.size !== baseline.localVersion.size || before.mtime !== baseline.localVersion.mtime) return undefined;
  const bytes = new Uint8Array(await vault.readBinary(file));
  const after = await vault.adapter.stat(path);
  if (!after || after.size !== baseline.localVersion.size || after.mtime !== baseline.localVersion.mtime) return undefined;
  if (bytes.byteLength > MAX_MERGEABLE_BYTES) return undefined;
  const decoded = decodeText(bytes);
  if (!decoded) return undefined;
  return {
    protocolVersion: CONFLICT_PROTOCOL_VERSION,
    channel,
    path,
    baseline,
    sha256: await sha256Hex(bytes),
    byteLength: bytes.byteLength,
    encoding: decoded.shape,
    content: decoded.text,
    updatedAt: now(),
  };
}

/**
 * Records a proven-converged batch with bounded file I/O and one IndexedDB write/prune step.
 * A skipped or failed snapshot affects only later auto-merge availability, never sync correctness.
 */
export async function recordMergeBaseBatch(vault: Vault, channel: string, store: MergeBaseStore, inputs: readonly MergeBaseInput[], now: () => number = () => Date.now()): Promise<void> {
  const records: MergeBaseRecord[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < inputs.length) {
      const input = inputs[cursor++];
      try {
        const record = await prepareRecord(vault, channel, input, now);
        if (record) records.push(record);
      } catch { /* a single unavailable snapshot must not block the remaining batch */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MERGE_BASE_RECORD_CONCURRENCY, inputs.length) }, () => worker()));
  if (!records.length) return;
  await store.putMany(records);
  await store.prune(channel, 2000);
}

/**
 * Records merge-base snapshots for paths that are already proven converged.
 *
 * Only the *normalized* text (LF, no BOM) is stored, alongside the shape needed to re-encode it. A
 * snapshot is skipped — never faked — when the path is not a mergeable text type, when it exceeds the
 * size ceiling, when it is not valid UTF-8, or when the file vanished between the write and this read.
 * Every skip only costs future auto-merge ability.
 */
export function createMergeBaseRecorder(vault: Vault, channel: string, store: MergeBaseStore, now: () => number = () => Date.now()): MergeBaseRecorder {
  return {
    async record({ path, baseline }) {
      const record = await prepareRecord(vault, channel, { path, baseline }, now);
      if (!record) return;
      await store.put(record);
      await store.prune(channel, 2000);
    },
  };
}
