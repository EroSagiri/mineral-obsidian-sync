import type { R2Client } from "../../remote/r2-client";
import type { IntegrationTestNamespace } from "./test-namespace";

/** Shared context for every transport-level scenario and probe. */
export interface TransportScenarioContext {
  namespace: IntegrationTestNamespace;
  /** Already prefix-guarded: it refuses any key outside the run root. */
  client: R2Client;
  /** Defaults to cryptographically secure random bytes, chunked for large payloads. */
  randomBytes?: (size: number) => Uint8Array;
  /**
   * `"android" | "ios" | "desktop" | ...`. Mobile transports drop the response of a HEAD that is
   * not 2xx (measured on Obsidian for Android, 2026-09-21), so a few probes carry a
   * platform-specific expectation instead of failing forever on a documented limitation.
   */
  platform?: string;
}

/** Mobile Obsidian cannot deliver a non-2xx HEAD response: the transport throws instead. */
export function headErrorsAreOpaque(platform: string | undefined): boolean {
  return platform === "android" || platform === "ios";
}
