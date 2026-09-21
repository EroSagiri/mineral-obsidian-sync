/**
 * Phase 2A.5 integration-test namespace and hard prefix guard.
 *
 * Two invariants are enforced here, and they are deliberately separate:
 *
 * 1. **Remote safety (non-negotiable).** Every R2 object key an integration helper can produce
 *    must land inside `<configuredPrefix>.mineral-sync-test/<run-id>/`. This is checked on the
 *    *mapped object key*, i.e. on what R2 will actually receive, not on the Vault path.
 * 2. **Local safety.** Every Vault path an integration helper can touch must live inside a
 *    run-scoped scratch root, and callers never hand-build a path: they mint a leaf name.
 *
 * The local root is resolved at runtime (see `local-scratch.ts`) because Obsidian's Vault API
 * may refuse to create a dot-directory. The remote invariant does not depend on that choice.
 */

export const INTEGRATION_TEST_ROOT = ".mineral-sync-test/";

/** Vault-relative fallback root, used only when Obsidian refuses the dot-directory. */
export const INTEGRATION_FALLBACK_ROOT = "private/mineral-sync-test-local/";

/** `20260922T001500Z` — one run directory per validation round. */
const RUN_ID = /^\d{8}T\d{6}Z$/;
/** A relative leaf: no empty segments, no `.`/`..`, no absolute or backslash paths. */
const LEAF = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** Thrown when an integration helper is asked to touch anything outside the test scope. */
export class IntegrationTestEscapeError extends Error {
  constructor(readonly key: string) {
    super(`Integration test refused a key outside the test scope: ${JSON.stringify(key)}`);
    this.name = "IntegrationTestEscapeError";
  }
}

/** The single hard guard for run-directory naming. */
export function assertIntegrationTestKey(key: string): void {
  if (typeof key !== "string" || !key.startsWith(INTEGRATION_TEST_ROOT)) throw new IntegrationTestEscapeError(String(key));
  const rest = key.slice(INTEGRATION_TEST_ROOT.length);
  const runId = rest.split("/")[0] ?? "";
  if (!RUN_ID.test(runId)) throw new IntegrationTestEscapeError(key);
}

/**
 * The remote invariant, checked on the object key R2 will receive: after removing the user's
 * configured remote prefix, the object key must still be inside the run's test root.
 */
export function assertIntegrationObjectKey(objectKey: string, configuredPrefix: string, objectRoot: string): void {
  const prefix = normalizeConfiguredPrefix(configuredPrefix);
  if (!objectKey.startsWith(prefix)) throw new IntegrationTestEscapeError(objectKey);
  const relative = objectKey.slice(prefix.length);
  if (!relative.startsWith(objectRoot)) throw new IntegrationTestEscapeError(objectKey);
}

/** The local invariant: a Vault path must live inside the resolved scratch root. */
export function assertIntegrationLocalKey(key: string, localRoot: string): void {
  if (typeof key !== "string" || !key.startsWith(localRoot)) throw new IntegrationTestEscapeError(String(key));
}

export function normalizeConfiguredPrefix(prefix: string): string {
  const trimmed = prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}

/** The only supported way to name a scoped object. */
export function mintScopedKey(root: string, leaf: string): string {
  const segments = typeof leaf === "string" ? leaf.split("/") : [];
  if (!LEAF.test(leaf) || segments.some((part) => part === "." || part === "..")) throw new IntegrationTestEscapeError(`${root}${leaf}`);
  const key = root + leaf;
  if (!key.startsWith(root)) throw new IntegrationTestEscapeError(key);
  return key;
}

export function isLeaf(leaf: string): boolean {
  try {
    mintScopedKey("", leaf);
    return true;
  } catch {
    return false;
  }
}

export function formatRunId(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

export class IntegrationTestNamespace {
  private constructor(readonly runId: string) {
    if (!RUN_ID.test(runId)) throw new IntegrationTestEscapeError(`${INTEGRATION_TEST_ROOT}${runId}/`);
  }

  /** Mints a fresh run directory from the current UTC second. */
  static mint(now: Date = new Date()): IntegrationTestNamespace {
    return new IntegrationTestNamespace(formatRunId(now));
  }

  static fromRunId(runId: string): IntegrationTestNamespace {
    return new IntegrationTestNamespace(runId);
  }

  /** `.mineral-sync-test/<runId>/` — both the remote object root and the preferred local root. */
  get root(): string {
    return `${INTEGRATION_TEST_ROOT}${this.runId}/`;
  }

  /** The R2 object prefix (relative to the configured prefix) every object must land inside. */
  get objectRoot(): string {
    return this.root;
  }

  /** The only supported way to name a test object under the hidden run root. */
  key(leaf: string): string {
    const key = mintScopedKey(this.root, leaf);
    this.assertOwns(key);
    return key;
  }

  assertOwns(key: string): void {
    assertIntegrationTestKey(key);
    if (!key.startsWith(this.root)) throw new IntegrationTestEscapeError(key);
  }

  isOwned(key: string): boolean {
    try {
      this.assertOwns(key);
      return true;
    } catch {
      return false;
    }
  }

  /** Preferred (hidden) local root; the fallback is `<INTEGRATION_FALLBACK_ROOT><runId>/`. */
  get preferredLocalBase(): string {
    return this.root;
  }

  get fallbackLocalBase(): string {
    return `${INTEGRATION_FALLBACK_ROOT}${this.runId}/`;
  }
}
