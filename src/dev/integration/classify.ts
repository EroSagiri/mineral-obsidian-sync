import { RemoteHttpError, RemoteObjectChangedError } from "../../remote/errors";
import { IntegrationTestEscapeError } from "./test-namespace";

/**
 * Maps a thrown error onto a stable category so a report never depends on message text.
 *
 * `transport-error` is the interesting category: it means the request never produced an HTTP
 * response at all. Obsidian on Android throws exactly that for a HEAD whose response is not 2xx —
 * which is why every error-path probe in the matrix exists.
 */
export function classifyTransportError(error: unknown): string {
  if (error instanceof RemoteObjectChangedError) return "precondition-failed";
  if (error instanceof RemoteHttpError) return `http-${error.status}`;
  if (error instanceof IntegrationTestEscapeError) return "guard-rejected";
  return "transport-error";
}
