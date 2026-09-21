import type { R2Client } from "./r2-client";
import type { VaultPathFilter } from "../sync/ignore";
import type { RemoteEntry } from "../sync/types";
export async function scanRemote(client: R2Client, filter: VaultPathFilter): Promise<Map<string, RemoteEntry>> {
  return new Map((await client.listObjects()).filter((entry) => !filter.ignores(entry.key)).map((entry) => [entry.key, entry]));
}
