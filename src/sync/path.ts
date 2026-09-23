export function canonicalKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Path must be a non-empty vault-relative path without traversal");
  }
  return normalized;
}

export function normalizePrefix(prefix: string): string {
  if (!prefix.trim()) return "";
  return `${canonicalKey(prefix.replace(/\/+$/, ""))}/`;
}

export function remoteObjectKey(prefix: string, vaultKey: string): string {
  return normalizePrefix(prefix) + canonicalKey(vaultKey);
}

export function vaultKeyFromRemote(prefix: string, objectKey: string): string | undefined {
  const normalizedPrefix = normalizePrefix(prefix);
  if (normalizedPrefix && !objectKey.startsWith(normalizedPrefix)) return undefined;
  return canonicalKey(objectKey.slice(normalizedPrefix.length));
}

/**
 * A short, non-reversible digest of a path.
 *
 * Debug telemetry in this plugin deliberately never carries a key, and this is how the two constraints
 * — "say which path this was about" and "never log a path" — are reconciled: the digest is stable for
 * correlation within a session and reveals nothing on its own. FNV-1a keeps this synchronous, so a
 * diagnostic can never add an await to a transfer.
 */
export function pathDigest(key: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
