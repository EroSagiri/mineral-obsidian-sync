import type { Vault } from "obsidian";
import type { MergeBaseRecorder } from "../sync/executor";
import { MAX_MERGEABLE_BYTES, decodeText, isMergeablePath } from "../sync/text";
import { sha256Hex } from "./identity";
import { CONFLICT_PROTOCOL_VERSION, type MergeBaseStore } from "./types";

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
      if (!channel) return;
      if (!isMergeablePath(path)) return;
      const file = vault.getFileByPath(path);
      if (!file) return;
      const bytes = new Uint8Array(await vault.readBinary(file));
      // The ceiling is on real bytes, and a very large file is simply not a merge candidate.
      if (bytes.byteLength > MAX_MERGEABLE_BYTES) return;
      const decoded = decodeText(bytes);
      if (!decoded) return;
      await store.put({
        protocolVersion: CONFLICT_PROTOCOL_VERSION,
        channel,
        path,
        baseline,
        sha256: await sha256Hex(bytes),
        byteLength: bytes.byteLength,
        encoding: decoded.shape,
        content: decoded.text,
        updatedAt: now(),
      });
      // Bounded growth: a vault long enough will otherwise accumulate a snapshot per file forever.
      await store.prune(channel, 2000);
    },
  };
}
