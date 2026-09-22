import type { PreviousEntry } from "../sync/types";
import type { StateStore } from "./sync-state";

const STORE = "previous-sync-state";

export class IndexedDbStateStore implements StateStore {
  /** Retained across the plugin-ID rename so established device baselines survive. */
  constructor(private readonly databaseName = "r2-personal-sync-state-v1") {}

  private async database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to open device-local sync state"));
    });
  }

  async loadAll(): Promise<Map<string, PreviousEntry>> {
    const db = await this.database();
    try {
      const values = await new Promise<PreviousEntry[]>((resolve, reject) => {
        const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
        request.onsuccess = () => resolve(request.result as PreviousEntry[]);
        request.onerror = () => reject(request.error ?? new Error("Unable to read sync state"));
      });
      return new Map(values.map((entry) => [entry.key, entry]));
    } finally { db.close(); }
  }

  async saveAll(entries: Map<string, PreviousEntry>): Promise<void> {
    const db = await this.database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        const store = transaction.objectStore(STORE);
        store.clear();
        for (const entry of entries.values()) store.put(entry);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("Unable to save sync state"));
      });
    } finally { db.close(); }
  }

  async saveVerified(entries: Map<string, PreviousEntry>): Promise<void> {
    if (!entries.size) return;
    const db = await this.database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        const store = transaction.objectStore(STORE);
        for (const entry of entries.values()) store.put(entry);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("Unable to save verified sync state"));
      });
    } finally { db.close(); }
  }

  async put(entry: PreviousEntry): Promise<void> {
    const db = await this.database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        transaction.objectStore(STORE).put(entry);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("Unable to commit sync state"));
      });
    } finally { db.close(); }
  }

  /**
   * Removes one baseline entry. Device-local bookkeeping only: no Vault file and no R2 object is
   * touched. A missing key is not an error, because the caller's intent ("this baseline should no
   * longer exist") is already satisfied.
   */
  async delete(key: string): Promise<void> {
    const db = await this.database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        transaction.objectStore(STORE).delete(key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("Unable to remove the sync state entry"));
      });
    } finally { db.close(); }
  }
}
