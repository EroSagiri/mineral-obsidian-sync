export interface LocalEntry { key: string; size: number; mtime: number; }

/** A remote object **as observed on the wire**: every field is a fact the server supplied. */
export interface RemoteEntry { key: string; size: number; etag?: string; lastModified: number; }

/**
 * What is known about a remote object version after a successful conditional write.
 *
 * The schema is deliberately narrower than {@link RemoteEntry}, because a write response tells us
 * less than a scan does:
 *
 * - `etag`       authoritative — R2 returns the object's ETag on `PutObject`
 * - `size`       exactly the bytes we wrote
 * - `lastModified` **optional and normally absent**: `PutObject` does not return a server
 *                  timestamp, and filling it from the local clock would replace a known-unknown
 *                  with a lie. The next `ListObjectsV2` supplies the real value.
 *
 * The key lives on {@link PreviousEntry.key}; nothing on this path needs a duplicate.
 */
export interface RemoteVersion { size: number; etag?: string; lastModified?: number; }

export interface PreviousEntry {
  key: string;
  local?: { size: number; mtime: number; hash?: string };
  remote?: RemoteVersion & { hash?: string };
  syncedAt: number;
  /** A baseline is valid only for this exact endpoint/bucket/prefix namespace. */
  remoteIdentity?: RemoteIdentity;
  /** Intentionally invalidates reuse after ignore/unignore policy changes. */
  ignorePolicy?: string;
}
export interface RemoteIdentity { endpoint: string; bucket: string; remotePrefix: string; }

/** A content-derived identity. It is deliberately distinct from S3 ETags. */
export interface ContentFingerprint {
  algorithm: "sha256";
  value: string;
}

export type ConflictKind =
  | "both-modified"
  | "local-modified-remote-deleted"
  | "local-deleted-remote-modified"
  | "both-created-different"
  | "ambiguous";

export type SyncOperation =
  | { type: "noop"; key: string; reason: string }
  | { type: "upload"; key: string; reason: string; expectedLocal: LocalEntry; expectedRemote: { kind: "absent" } | { kind: "etag"; value?: string } }
  | { type: "download"; key: string; reason: string; expectedLocal: LocalEntry | { kind: "absent" }; expectedRemote: RemoteEntry }
  /**
   * Local deletion, planned only when the remote is provably gone and the local version is provably
   * unchanged since the recorded baseline. `expectedLocal` is the observation the deletion decision
   * was made from; the executor revalidates it immediately before touching anything, so a file that
   * changed after the scan is never the file that gets removed.
   */
  | { type: "delete-local"; key: string; reason: string; expectedLocal: LocalEntry }
  | { type: "delete-remote"; key: string; reason: string }
  /**
   * Device-local bookkeeping removal. It is **not** a deletion of user data: it only forgets a
   * baseline entry for a key that is provably absent both locally and remotely, so it can stop
   * occupying the plan forever. Never touches a Vault file or an R2 object.
   */
  | { type: "prune-baseline"; key: string; reason: string }
  /**
   * Applying a user's (or a clean auto-merge's) explicit resolution to a conflicted key.
   *
   * These are deliberately *not* spelled as upload/download: the diagnostics, the preconditions and
   * the partial-success semantics all differ, and collapsing them into a transfer would hide that.
   * Every variant is bound to the exact conflict identity it was decided from, so a resolution can
   * never be applied to a version the user did not see.
   */
  | { type: "resolve-keep-local"; key: string; reason: string; conflictId: string; expectedLocal: LocalEntry; expectedRemoteETag?: string }
  | { type: "resolve-keep-remote"; key: string; reason: string; conflictId: string; expectedLocal: LocalEntry; expectedRemoteETag?: string }
  | { type: "resolve-merged"; key: string; reason: string; conflictId: string; expectedLocal: LocalEntry; expectedRemoteETag?: string; merged: { content: string; sha256: string; encoding: { bom: boolean; eol: "lf" | "crlf" | "mixed"; trailingNewline: boolean } } }
  | { type: "conflict"; key: string; conflict: ConflictKind; reason: string };

export interface SyncPlan { operations: SyncOperation[]; }

export interface ChangeNotifier { dirty(key: string): Promise<void>; }
export class NoopChangeNotifier implements ChangeNotifier { async dirty(_key: string): Promise<void> {} }
