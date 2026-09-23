import { canonicalKey } from "../sync/path";

/** Reserved below every configured remote prefix. It is never a Vault path. */
export const TOMBSTONE_NAMESPACE = ".mineral-sync/tombstones/";
export const TOMBSTONE_PROTOCOL = 1;

/**
 * How long a tombstone is kept before it may be cleaned up.
 *
 * The number is a device-offline budget, not a cache lifetime: a client that was away longer than this
 * may come back to a path whose object is gone and whose tombstone has been removed. That is survivable
 * *only* because the tombstone is not the last line of defence — the local baseline also makes the
 * deletion legible ("remote gone, local unchanged" plans a deletion; "remote gone, local modified"
 * plans a conflict), so a missing tombstone costs a device the deletion's *version identity*, never the
 * fact that it happened. Thirty days is chosen from that trade, deliberately on the generous side.
 */
export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RemoteTombstone {
  protocol: typeof TOMBSTONE_PROTOCOL;
  path: string;
  deletedRemoteETag: string;
  createdAt: string;
}

export interface RemoteDeletion {
  tombstone: RemoteTombstone;
  /** The opaque R2 metadata-object identity, used only for diagnostics. */
  metadataETag?: string;
  /**
   * When R2 accepted the tombstone, on **R2's** clock.
   *
   * Retention needs this to tell the bytes the deletion named from the same bytes uploaded again later —
   * an ETag cannot, because it is a digest of the content. The record's own `createdAt` cannot either: it
   * is the deleting device's clock, and comparing two devices' clocks is exactly the mistake this project
   * keeps out of its decisions. Absent when the record was not read from a listing.
   */
  metadataLastModified?: number;
}

export function isInternalRemoteKey(key: string): boolean {
  return canonicalKey(key).startsWith(TOMBSTONE_NAMESPACE);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * A tombstone is immutable and version-bound. Different remote versions of the same path have
 * different metadata keys, so a later deletion never overwrites evidence for an earlier one.
 */
export async function tombstoneKey(path: string, deletedRemoteETag: string): Promise<string> {
  const canonical = canonicalKey(path);
  if (!deletedRemoteETag) throw new Error("Tombstone requires an exact remote ETag");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${canonical}\u0000${deletedRemoteETag}`));
  return `${TOMBSTONE_NAMESPACE}${base64url(new Uint8Array(digest))}.json`;
}

export function encodeTombstone(record: RemoteTombstone): ArrayBuffer {
  validateTombstone(record);
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Fail closed: malformed metadata never means a user object was deleted. */
export function parseTombstone(body: ArrayBuffer): RemoteTombstone {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(body)); }
  catch { throw new Error("Malformed tombstone JSON"); }
  validateTombstone(value);
  return value;
}

export function validateTombstone(value: unknown): asserts value is RemoteTombstone {
  if (!value || typeof value !== "object") throw new Error("Malformed tombstone record");
  const record = value as Partial<RemoteTombstone>;
  if (record.protocol !== TOMBSTONE_PROTOCOL || typeof record.path !== "string" || typeof record.deletedRemoteETag !== "string" || !record.deletedRemoteETag || typeof record.createdAt !== "string" || !record.createdAt) throw new Error("Unsupported or incomplete tombstone record");
  if (canonicalKey(record.path) !== record.path || isInternalRemoteKey(record.path)) throw new Error("Tombstone contains an invalid path");
  if (!Number.isFinite(Date.parse(record.createdAt))) throw new Error("Tombstone has an invalid creation time");
}
