import type { HotHandoffRecord, HotOutboxEntry, HotSessionRecord } from "./types";

/**
 * Durable plugin-side hot state.
 *
 * It lives in its own IndexedDB database rather than beside the previous-state baselines, for the same
 * reason the Gateway cursors do: widening the store whose contents decide *deletion inference* is a
 * much larger risk than losing a hot record, and a lost hot record costs a re-acquisition, not a file.
 */
export interface HotStateStore {
  loadSessions(): Promise<HotSessionRecord[]>;
  putSession(record: HotSessionRecord): Promise<void>;
  deleteSession(canonicalPath: string): Promise<void>;

  loadOutbox(): Promise<HotOutboxEntry[]>;
  putOutbox(entry: HotOutboxEntry): Promise<void>;
  deleteOutbox(key: string): Promise<void>;

  loadHandoffs(): Promise<HotHandoffRecord[]>;
  putHandoff(record: HotHandoffRecord): Promise<void>;
  deleteHandoff(canonicalPath: string): Promise<void>;
}

const SESSIONS = "hot-sessions";
const OUTBOX = "hot-outbox";
const HANDOFFS = "hot-handoffs";

export class IndexedDbHotStateStore implements HotStateStore {
  constructor(private readonly databaseName = "r2-personal-sync-hot-v1") {}

  private database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: "canonicalPath" });
        if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: "key" });
        if (!db.objectStoreNames.contains(HANDOFFS)) db.createObjectStore(HANDOFFS, { keyPath: "canonicalPath" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to open hot-session state"));
    });
  }

  private async all<T>(store: string): Promise<T[]> {
    const db = await this.database();
    try {
      return await new Promise<T[]>((resolve, reject) => {
        const request = db.transaction(store, "readonly").objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result as T[]);
        request.onerror = () => reject(request.error ?? new Error(`Unable to read ${store}`));
      });
    } finally { db.close(); }
  }

  private async write(store: string, operation: (objectStore: IDBObjectStore) => void, failure: string): Promise<void> {
    const db = await this.database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(store, "readwrite");
        operation(transaction.objectStore(store));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error(failure));
      });
    } finally { db.close(); }
  }

  loadSessions(): Promise<HotSessionRecord[]> { return this.all<HotSessionRecord>(SESSIONS); }
  putSession(record: HotSessionRecord): Promise<void> { return this.write(SESSIONS, store => store.put(record), "Unable to save the hot session"); }
  deleteSession(canonicalPath: string): Promise<void> { return this.write(SESSIONS, store => store.delete(canonicalPath), "Unable to forget the hot session"); }

  loadOutbox(): Promise<HotOutboxEntry[]> { return this.all<HotOutboxEntry>(OUTBOX); }
  putOutbox(entry: HotOutboxEntry): Promise<void> { return this.write(OUTBOX, store => store.put(entry), "Unable to persist an unacknowledged edit"); }
  deleteOutbox(key: string): Promise<void> { return this.write(OUTBOX, store => store.delete(key), "Unable to clear an acknowledged edit"); }

  loadHandoffs(): Promise<HotHandoffRecord[]> { return this.all<HotHandoffRecord>(HANDOFFS); }
  putHandoff(record: HotHandoffRecord): Promise<void> { return this.write(HANDOFFS, store => store.put(record), "Unable to persist a pending handoff"); }
  deleteHandoff(canonicalPath: string): Promise<void> { return this.write(HANDOFFS, store => store.delete(canonicalPath), "Unable to clear a completed handoff"); }
}

/** The same contract, in memory: used by tests and as a fallback when IndexedDB is unavailable. */
export class MemoryHotStateStore implements HotStateStore {
  private sessions = new Map<string, HotSessionRecord>();
  private outbox = new Map<string, HotOutboxEntry>();
  private handoffs = new Map<string, HotHandoffRecord>();

  async loadSessions(): Promise<HotSessionRecord[]> { return [...this.sessions.values()]; }
  async putSession(record: HotSessionRecord): Promise<void> { this.sessions.set(record.canonicalPath, { ...record }); }
  async deleteSession(canonicalPath: string): Promise<void> { this.sessions.delete(canonicalPath); }

  async loadOutbox(): Promise<HotOutboxEntry[]> { return [...this.outbox.values()]; }
  async putOutbox(entry: HotOutboxEntry): Promise<void> { this.outbox.set(entry.key, { ...entry }); }
  async deleteOutbox(key: string): Promise<void> { this.outbox.delete(key); }

  async loadHandoffs(): Promise<HotHandoffRecord[]> { return [...this.handoffs.values()]; }
  async putHandoff(record: HotHandoffRecord): Promise<void> { this.handoffs.set(record.canonicalPath, { ...record }); }
  async deleteHandoff(canonicalPath: string): Promise<void> { this.handoffs.delete(canonicalPath); }
}
