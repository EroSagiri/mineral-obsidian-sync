import type { RemoteGenerationCursor } from "@mineral/sync-core/sync-change";

/**
 * Gateway control-plane configuration.
 *
 * It is deliberately separate from `R2SyncSettings`: endpoint, token, and channel describe a wake-up
 * service, while the R2 fields describe where bytes actually live. They must never be conflated —
 * a Gateway outage may not degrade the data plane, and R2 credentials must never reach the Gateway.
 *
 * There is no channel field: the channel is derived from the R2 `RemoteIdentity` so that it cannot
 * drift from the namespace it actually describes.
 */
export interface GatewaySettings {
  gatewayEnabled: boolean;
  gatewayEndpoint: string;
  gatewayToken: string;
}

export const DEFAULT_GATEWAY_SETTINGS: GatewaySettings = { gatewayEnabled: false, gatewayEndpoint: "", gatewayToken: "" };

/**
 * The shape the client actually consumes. Derived from persisted settings rather than stored, so the
 * settings object can keep its flat, prefixed, `data.json`-friendly field names while the client
 * works with one self-contained configuration value captured per cycle.
 */
export interface GatewayConnectionConfig {
  enabled: boolean;
  endpoint: string;
  token: string;
}

export function gatewayConnectionConfig(settings: GatewaySettings): GatewayConnectionConfig {
  return { enabled: settings.gatewayEnabled, endpoint: settings.gatewayEndpoint, token: settings.gatewayToken };
}

/**
 * Per-channel cursor storage. Kept in its own database rather than added to the previous-state store,
 * because widening that store's schema risks the deletion-inference baseline this plugin depends on.
 */
export interface GatewayCursorStore {
  load(channel: string): Promise<RemoteGenerationCursor | undefined>;
  save(channel: string, cursor: RemoteGenerationCursor): Promise<void>;
}

export type GatewayConfigState =
  | { kind: "disabled" }
  | { kind: "misconfigured"; reason: "endpoint-missing" | "token-missing" | "endpoint-invalid" | "identity-missing" }
  | { kind: "ready"; channel: string };
