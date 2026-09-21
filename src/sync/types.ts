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
  | { type: "delete-local"; key: string; reason: string }
  | { type: "delete-remote"; key: string; reason: string }
  | { type: "conflict"; key: string; conflict: ConflictKind; reason: string };

export interface SyncPlan { operations: SyncOperation[]; }

export interface ChangeNotifier { dirty(key: string): Promise<void>; }
export class NoopChangeNotifier implements ChangeNotifier { async dirty(_key: string): Promise<void> {} }
