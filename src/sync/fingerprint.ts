import type { ContentFingerprint, LocalEntry, PreviousEntry, RemoteEntry } from "./types";

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Web Crypto only: this remains usable in Obsidian mobile WebViews. */
export async function sha256(bytes: ArrayBuffer | Uint8Array): Promise<ContentFingerprint> {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const input = new Uint8Array(source.byteLength); input.set(source);
  return { algorithm: "sha256", value: hex(await crypto.subtle.digest("SHA-256", input.buffer)) };
}

export function localChanged(local: LocalEntry, previous: PreviousEntry): boolean {
  const prior = previous.local;
  return !prior || local.size !== prior.size || local.mtime !== prior.mtime;
}

export function remoteChanged(remote: RemoteEntry, previous: PreviousEntry): boolean {
  const prior = previous.remote;
  if (!prior) return true;
  if (remote.size !== prior.size) return true;
  // An ETag on either side is authoritative and settles the question on its own.
  if (remote.etag !== undefined || prior.etag !== undefined) return remote.etag !== prior.etag;
  // Without ETags the server timestamp is the only signal left. A baseline recorded from a write
  // carries no timestamp at all, so an unknown baseline is treated as changed: that can only cost
  // a redundant download or a conflict, never a missed remote change.
  if (prior.lastModified === undefined) return true;
  return remote.lastModified !== prior.lastModified;
}
