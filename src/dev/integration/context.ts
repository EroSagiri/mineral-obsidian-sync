import type { R2Client } from "../../remote/r2-client";
import type { IntegrationTestNamespace } from "./test-namespace";

/** Shared context for every transport-level scenario and probe. */
export interface TransportScenarioContext {
  namespace: IntegrationTestNamespace;
  /** Already prefix-guarded: it refuses any key outside the run root. */
  client: R2Client;
  /** Defaults to cryptographically secure random bytes, chunked for large payloads. */
  randomBytes?: (size: number) => Uint8Array;
}
