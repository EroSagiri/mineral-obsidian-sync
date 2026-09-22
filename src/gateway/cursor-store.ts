import { parseGenerationCursor, type RemoteGenerationCursor } from "@mineral/sync-core/sync-change";
import type { GatewayCursorStore } from "./types";

const STORE = "channel-cursors";

/**
 * Per-channel Gateway cursor storage.
 *
 * This deliberately uses its **own** IndexedDB database instead of extending the previous-state
 * store. Widening `r2-personal-sync-state-v1` would require a schema migration on a store whose
 * exact contents decide deletion inference; a cursor has no business endangering that. Keeping them
 * separate means the worst case for corrupt cursor storage is one redundant full reconciliation.
 *
 * A cursor is sync runtime state, not a user setting: it is never written to the plugin's data.json
 * and never appears in the settings UI.
 */
export class IndexedDbGatewayCursorStore implements GatewayCursorStore {
  constructor(private readonly databaseName = "r2-personal-sync-gateway-v1") {}

  private async database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "channel" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to open the gateway cursor store"));
    });
  }

  async load(channel: string): Promise<RemoteGenerationCursor | undefined> {
    const db = await this.database();
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction(STORE, "readonly").objectStore(STORE).get(channel);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Unable to read the gateway cursor"));
      });
      if (!value || typeof value !== "object") return undefined;
      // Storage is never trusted: anything malformed falls back to an empty cursor.
      return parseGenerationCursor(value);
    } finally { db.close(); }
  }

  async save(channel: string, cursor: RemoteGenerationCursor): Promise<void> {
    const db = await this.database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        transaction.objectStore(STORE).put({ channel, ...cursor });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("Unable to save the gateway cursor"));
      });
    } finally { db.close(); }
  }
}

/** In-memory store for tests and for the degenerate case where IndexedDB is unavailable. */
export function createMemoryGatewayCursorStore(initial: Record<string, RemoteGenerationCursor> = {}): GatewayCursorStore & { entries: Map<string, RemoteGenerationCursor> } {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    load: async (channel) => entries.get(channel),
    save: async (channel, cursor) => { entries.set(channel, cursor); },
  };
}
