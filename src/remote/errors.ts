/** The scan's ETag no longer identifies the object returned by conditional GetObject. */
export class RemoteObjectChangedError extends Error {
  constructor() { super("R2 object changed since its metadata scan"); this.name = "RemoteObjectChangedError"; }
}

export class RemoteHttpError extends Error {
  constructor(readonly operation: string, readonly status: number) { super(`R2 ${operation} failed with HTTP ${status}`); this.name = "RemoteHttpError"; }
}

/**
 * No HTTP response was received at all: DNS, TLS, socket, or a platform transport failure.
 *
 * This is deliberately a different type from {@link RemoteHttpError}. `404`, `412`, `429` and `500`
 * are all *completed* HTTP exchanges with a known status, and `RequestUrlTransport` guarantees they
 * arrive as a response. Only a request that never completed reaches this class, which is exactly
 * the case where a write's outcome is genuinely unknown.
 */
export class RemoteTransportError extends Error {
  constructor(readonly operation: string, cause: unknown) {
    super(`R2 ${operation} produced no response (transport failure)`, { cause });
    this.name = "RemoteTransportError";
  }
}
