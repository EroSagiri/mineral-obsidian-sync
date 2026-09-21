/** The scan's ETag no longer identifies the object returned by conditional GetObject. */
export class RemoteObjectChangedError extends Error {
  constructor() { super("R2 object changed since its metadata scan"); this.name = "RemoteObjectChangedError"; }
}

export class RemoteHttpError extends Error {
  constructor(readonly operation: string, readonly status: number) { super(`R2 ${operation} failed with HTTP ${status}`); this.name = "RemoteHttpError"; }
}
