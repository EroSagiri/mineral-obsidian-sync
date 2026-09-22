import { deriveRemoteChangeChannel, isRemoteChangeChannel } from "@mineral/sync-core/channel";
import type { RemoteIdentity } from "../sync/types";
import type { GatewayConfigState, GatewaySettings } from "./types";

function usableEndpoint(endpoint: string): boolean {
  const trimmed = endpoint.trim();
  if (!trimmed) return false;
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try { new URL(trimmed); return true; } catch { return false; }
}

/**
 * Resolves the Gateway control-plane state from settings plus the current R2 identity.
 *
 * The channel is always *derived*, never entered by a user: a hand-typed opaque channel could
 * silently disagree with the namespace it claims to describe, and the failure mode would be a
 * silent loss of cross-device wake-ups rather than an error. Deriving it means Windows, Android, and
 * any future Vault writer agree by construction.
 *
 * Everything here is a "cleanly disabled" outcome rather than an error: a misconfigured Gateway must
 * leave cold sync completely untouched.
 */
export async function resolveGatewayConfig(settings: GatewaySettings, identity: RemoteIdentity): Promise<GatewayConfigState> {
  if (!settings.gatewayEnabled) return { kind: "disabled" };
  if (!settings.gatewayEndpoint.trim()) return { kind: "misconfigured", reason: "endpoint-missing" };
  if (!usableEndpoint(settings.gatewayEndpoint)) return { kind: "misconfigured", reason: "endpoint-invalid" };
  if (!settings.gatewayToken.trim()) return { kind: "misconfigured", reason: "token-missing" };
  if (!identity.endpoint.trim() || !identity.bucket.trim()) return { kind: "misconfigured", reason: "identity-missing" };
  const channel = await deriveRemoteChangeChannel({ endpoint: identity.endpoint, bucket: identity.bucket, remotePrefix: identity.remotePrefix });
  // A derivation that does not satisfy the protocol pattern is a bug, not a configuration problem;
  // treating it as misconfigured keeps the socket closed instead of subscribing to a broken path.
  return isRemoteChangeChannel(channel) ? { kind: "ready", channel } : { kind: "misconfigured", reason: "identity-missing" };
}

/** Configuration identity used to fence a running cycle against a settings change. */
export function gatewayConfigFingerprint(settings: GatewaySettings, identity: RemoteIdentity, channel: string | undefined): string {
  return JSON.stringify([settings.gatewayEnabled, settings.gatewayEndpoint.trim(), channel ?? "", identity.endpoint, identity.bucket, identity.remotePrefix]);
}

/** A token change must re-connect too, but the token itself must never enter a comparable string. */
export function gatewayTokenFingerprint(token: string): string {
  return token ? `${token.length}:${token.slice(0, 4)}` : "";
}
