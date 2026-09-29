import type { CheckpointReceipt } from "@mineral/sync-core/hot-protocol";

/**
 * Plugin-side hot-session state (Phase Hot-D).
 *
 * These are the shapes that have to survive a restart. Everything a hot session owes the server — an
 * operation the user typed, a checkpoint the handoff is waiting for, the fact that a document is hot
 * at all — lives here rather than in a `Set<string>`, because the platform the plugin runs on can be
 * killed at any moment and "we will remember it in memory" is not a durability story.
 */

/** Where one path's hot session is in its lifecycle. */
export type HotSessionStatus =
  | "idle"
  | "connecting"
  | "hot"
  | "disconnected"
  | "saving"
  | "handoff-pending"
  | "conflict"
  | "closed";

/**
 * A durable hot session record.
 *
 * `documentId + epoch` is the document's identity, and the path is only the binding it currently
 * occupies: a rename changes the path and the epoch, and this record follows the document rather than
 * the name.
 */
export interface HotSessionRecord {
  canonicalPath: string;
  documentId: string;
  epoch: number;
  clientId: string;
  status: HotSessionStatus;
  /** The highest server revision this device has had acknowledged. */
  lastAcceptedRevision: number;
  /** The highest revision the server has confirmed it wrote to R2. */
  lastCheckpointedRevision: number;
  /** `true` while a checkpoint the handoff depends on has not landed. */
  pendingSave: boolean;
  /** The last revision this device asked to have covered by a checkpoint, if any. */
  requestedRevision: number | null;
  updatedAt: number;
}

/**
 * One unacknowledged operation.
 *
 * The outbox is keyed by `(documentId, epoch, clientOperationId)` so that a restart can re-send
 * exactly what it sent before: the server deduplicates on the same triple, so a redelivery is a
 * no-op rather than a second edit.
 */
export interface HotOutboxEntry {
  key: string;
  canonicalPath: string;
  documentId: string;
  epoch: number;
  clientId: string;
  clientOperationId: string;
  /** base64url Yjs update. */
  update: string;
  createdAt: number;
  attempts: number;
}

/**
 * A handoff that could not complete.
 *
 * It is written *before* the handoff is attempted and removed only when the last step succeeded, so a
 * crash in the middle leaves the plugin knowing that cold sync may not take this path back yet.
 */
export interface HotHandoffRecord {
  canonicalPath: string;
  documentId: string;
  epoch: number;
  /** The revision the cold baseline must correspond to. */
  requiredRevision: number;
  contentHash: string;
  r2ETag: string | null;
  createdAt: number;
}

export interface HotBaseline {
  canonicalPath: string;
  contentHash: string;
  r2ETag: string | null;
  documentRevision: number;
  checkpointedAt: number;
}

export function outboxKey(documentId: string, epoch: number, clientOperationId: string): string {
  return `${documentId}:${epoch}:${clientOperationId}`;
}

export function sessionStatusIsOperational(status: HotSessionStatus): boolean {
  return status === "hot" || status === "saving" || status === "disconnected" || status === "connecting";
}

/**
 * Whether the cold path may mutate a path that has a hot history.
 *
 * Ownership is released only when the handoff has actually completed, which is why `handoff-pending`
 * fences: the server may still owe R2 a save that a cold download would overwrite locally.
 */
export function sessionStatusFencesCold(status: HotSessionStatus): boolean {
  return status === "hot" || status === "saving" || status === "connecting" || status === "disconnected" || status === "handoff-pending" || status === "conflict";
}

export function isHandoffComplete(receipt: CheckpointReceipt, localContentHash: string): boolean {
  return receipt.contentHash === localContentHash;
}
