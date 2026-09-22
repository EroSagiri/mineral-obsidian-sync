/** The plugin's classification of Gateway control-plane failures. */
export type GatewayErrorKind = "transport" | "timeout" | "auth" | "client" | "server" | "malformed" | "misconfigured";

/**
 * Every Gateway failure is surfaced as this type rather than as a raw platform exception.
 *
 * The distinction matters because a control-plane failure must never be mistaken for a data-plane
 * one: "the Gateway did not answer" and "the R2 write failed" are different facts, and only the
 * second may change an upload's outcome.
 */
export class GatewayRequestError extends Error {
  constructor(readonly kind: Exclude<GatewayErrorKind, "misconfigured">, cause?: unknown) {
    super(`gateway request failed (${kind})`, { cause });
    this.name = "GatewayRequestError";
  }
}
