import type { R2Client } from "../../remote/r2-client";
import { remoteObjectKey } from "../../sync/path";
import type { RemoteEntry } from "../../sync/types";
import { IntegrationTestEscapeError, assertIntegrationLocalKey, assertIntegrationObjectKey } from "./test-namespace";

export { IntegrationTestEscapeError };

/**
 * What an integration client is allowed to touch.
 *
 * - `configuredPrefix` is the user's real remote prefix; the object key is verified *relative*
 *   to it, so the check is about what R2 actually receives.
 * - `objectRoot` is the object-prefix the key must land inside, always
 *   `.mineral-sync-test/<run-id>/`.
 * - `localRoot` is the Vault prefix the key must live inside, which may be the hidden run
 *   directory or the visible fallback directory.
 */
export interface IntegrationGuardPolicy {
  configuredPrefix: string;
  objectRoot: string;
  localRoot: string;
}

/**
 * The only R2 client an integration helper is allowed to hold.
 *
 * Every key-taking method validates the Vault key *and* the mapped object key before any
 * signing or networking happens. `listObjects` is read-only and filters out every key outside
 * the scratch root, so a canonical Vault object can never be reached through this client.
 */
export class GuardedIntegrationClient implements R2Client {
  constructor(
    private readonly inner: R2Client,
    private readonly clientPrefix: string,
    private readonly policy: IntegrationGuardPolicy,
  ) {}

  private guard(key: string): string {
    assertIntegrationLocalKey(key, this.policy.localRoot);
    assertIntegrationObjectKey(remoteObjectKey(this.clientPrefix, key), this.policy.configuredPrefix, this.policy.objectRoot);
    return key;
  }

  async listObjects(): Promise<RemoteEntry[]> {
    return (await this.inner.listObjects()).filter((entry) => entry.key.startsWith(this.policy.localRoot));
  }

  async headObject(key: string, options: { ifMatch?: string } = {}): Promise<RemoteEntry> {
    return this.inner.headObject(this.guard(key), options);
  }

  async getObject(key: string, options: { ifMatch?: string } = {}): Promise<ArrayBuffer> {
    return this.inner.getObject(this.guard(key), options);
  }

  async putObject(key: string, body: ArrayBuffer, options: { ifMatch?: string; ifNoneMatch?: "*" }): Promise<RemoteEntry> {
    return this.inner.putObject(this.guard(key), body, options);
  }
}
