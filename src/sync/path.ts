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
