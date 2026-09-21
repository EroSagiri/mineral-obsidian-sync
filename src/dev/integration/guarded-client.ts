import { RemoteHttpError } from "../../remote/errors";
import type { R2Client } from "../../remote/r2-client";
import { remoteObjectKey } from "../../sync/path";
import type { RemoteEntry } from "../../sync/types";
import { IntegrationTestEscapeError, assertIntegrationObjectKey } from "./test-namespace";
import type { IntegrationTestNamespace } from "./test-namespace";

export { IntegrationTestEscapeError };

/**
 * The only R2 client an integration helper is allowed to hold.
 *
 * Every key-taking method validates the Vault key against the run namespace *before* any
 * signing or networking happens, and additionally re-validates the mapped object key.
 * `listObjects` is read-only and filters out every key outside the run namespace, so a
 * real canonical Vault object can never be reached through this client.
 */
export class GuardedIntegrationClient implements R2Client {
  constructor(
    private readonly inner: R2Client,
    private readonly namespace: IntegrationTestNamespace,
    private readonly configuredPrefix: string,
  ) {}

  private guard(key: string): string {
    this.namespace.assertOwns(key);
    assertIntegrationObjectKey(remoteObjectKey(this.configuredPrefix, key), this.configuredPrefix);
    return key;
  }

  async listObjects(): Promise<RemoteEntry[]> {
    return (await this.inner.listObjects()).filter((entry) => this.namespace.isOwned(entry.key));
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

/** Narrowed head: a 404 means "absent" for planning purposes; every other status propagates. */
export async function headOrAbsent(client: R2Client, key: string): Promise<RemoteEntry | undefined> {
  try {
    return await client.headObject(key);
  } catch (error) {
    if (error instanceof RemoteHttpError && error.status === 404) return undefined;
    throw error;
  }
}
