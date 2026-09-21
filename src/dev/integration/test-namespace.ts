/**
 * Phase 2A.5 integration-test namespace and hard prefix guard.
 *
 * Nothing in this plugin may operate on a canonical Vault key during validation. Every
 * integration helper key must live inside `.mineral-sync-test/<run-id>/`, and the guard
 * is applied at the lowest layer (the guarded R2 client) so a caller cannot escape it by
 * passing a plausible-looking path. Callers never hand-build a Vault path: they mint a
 * leaf name through {@link IntegrationTestNamespace.key}.
 */

export const INTEGRATION_TEST_ROOT = ".mineral-sync-test/";

/** `20260922T001500Z` — one run directory per validation round. */
const RUN_ID = /^\d{8}T\d{6}Z$/;
/** A relative leaf: no empty segments, no `.`/`..`, no absolute or backslash paths. */
const LEAF = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** Thrown when an integration helper is asked to touch anything outside the test root. */
export class IntegrationTestEscapeError extends Error {
  constructor(readonly key: string) {
    super(`Integration test refused a key outside ${INTEGRATION_TEST_ROOT}: ${JSON.stringify(key)}`);
    this.name = "IntegrationTestEscapeError";
  }
}

/**
 * The single hard guard. It rejects any key that is not inside a run directory under
 * `.mineral-sync-test/`. It is deliberately strict: a missing run segment, a sibling
 * prefix such as `.mineral-sync-test-evil/`, and traversal are all refused.
 */
export function assertIntegrationTestKey(key: string): void {
  if (typeof key !== "string" || !key.startsWith(INTEGRATION_TEST_ROOT)) throw new IntegrationTestEscapeError(String(key));
  const rest = key.slice(INTEGRATION_TEST_ROOT.length);
  const runId = rest.split("/")[0] ?? "";
  if (!RUN_ID.test(runId)) throw new IntegrationTestEscapeError(key);
}

/**
 * Defense in depth for the mapped object key: after removing the configured remote
 * prefix, the object key must still be inside the test root.
 */
export function assertIntegrationObjectKey(objectKey: string, configuredPrefix: string): void {
  const prefix = normalizeConfiguredPrefix(configuredPrefix);
  if (!objectKey.startsWith(prefix)) throw new IntegrationTestEscapeError(objectKey);
  assertIntegrationTestKey(objectKey.slice(prefix.length));
}

function normalizeConfiguredPrefix(prefix: string): string {
  const trimmed = prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
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

  get root(): string {
    return `${INTEGRATION_TEST_ROOT}${this.runId}/`;
  }

  /** The only supported way to name a test object. */
  key(leaf: string): string {
    const segments = typeof leaf === "string" ? leaf.split("/") : [];
    if (!LEAF.test(leaf) || segments.some((part) => part === "." || part === "..")) throw new IntegrationTestEscapeError(`${this.root}${leaf}`);
    const key = this.root + leaf;
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
}
