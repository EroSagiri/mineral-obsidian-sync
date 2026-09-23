import { byNewestFirst, expiredHistoryIds } from "./retention";
import type { SyncHistoryEntry, SyncHistoryStore } from "./types";

/**
 * Sync-history persistence.
 *
 * A dedicated IndexedDB database rather than an extension of the conflict store or the previous-state
 * store: history is the largest of the three (it holds full text snapshots), and a schema change in a
 * store that sync correctness depends on is not a trade worth making for a viewer.
 *
 * Nothing here is sync truth, so every write is best-effort at the call site — a failed history write
 * must never fail a successful R2 transfer. `record` itself still rejects on a real failure, because
 * the caller is the only place that knows whether the failure is worth logging.
 */
const DATABASE = "r2-personal-sync-history-v1";
const EVENTS = "events";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EVENTS)) {
        const store = db.createObjectStore(EVENTS, { keyPath: ["channel", "id"] });
        store.createIndex("byChannel", "channel");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open the sync history store"));
  });
}

function transaction<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result: T;
    let settled = false;
    tx.oncomplete = () => { if (!settled) { settled = true; resolve(result); } };
    tx.onerror = () => { if (!settled) { settled = true; reject(tx.error ?? new Error("history store transaction failed")); } };
    tx.onabort = () => { if (!settled) { settled = true; reject(tx.error ?? new Error("history store transaction aborted")); } };
    Promise.resolve(run(tx)).then((value) => { result = value; }).catch((error) => { if (!settled) { settled = true; reject(error); } });
  });
}

const request = <T>(source: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  source.onsuccess = () => resolve(source.result);
  source.onerror = () => reject(source.error ?? new Error("history store request failed"));
});

/** Reads every entry of one channel, via the channel index. */
function perChannel(db: IDBDatabase, channel: string): Promise<SyncHistoryEntry[]> {
  return transaction(db, [EVENTS], "readonly", async (tx) => {
    const index = tx.objectStore(EVENTS).index("byChannel");
    return request(index.getAll(channel) as IDBRequest<SyncHistoryEntry[]>);
  });
}

export class IndexedDbSyncHistoryStore implements SyncHistoryStore {
  async record(entry: SyncHistoryEntry): Promise<void> {
    const db = await this.database();
    try {
      // The write and the prune share one transaction: a prune that ran separately could delete a
      // concurrent record, and a failure between the two would leave the store unbounded.
      await transaction(db, [EVENTS], "readwrite", async (tx) => {
        const store = tx.objectStore(EVENTS);
        store.put(entry);
        const existing = await request(store.index("byChannel").getAll(entry.channel) as IDBRequest<SyncHistoryEntry[]>);
        // Age is measured against the moment of the write, not the entry's own timestamp: a replayed
        // old entry must not be able to keep its expired neighbours alive.
        for (const id of expiredHistoryIds(existing, Date.now())) store.delete([entry.channel, id]);
      });
    } finally { db.close(); }
  }

  async list(channel: string): Promise<SyncHistoryEntry[]> {
    const db = await this.database();
    try {
      const entries = await perChannel(db, channel);
      // IndexedDB returns key order; the viewer needs time order, and the shared comparator keeps this
      // identical to the order retention measures "newest N" in.
      return entries.sort(byNewestFirst);
    } finally { db.close(); }
  }

  async get(channel: string, id: string): Promise<SyncHistoryEntry | undefined> {
    const db = await this.database();
    try {
      return await transaction(db, [EVENTS], "readonly", async (tx) =>
        request(tx.objectStore(EVENTS).get([channel, id]) as IDBRequest<SyncHistoryEntry | undefined>));
    } finally { db.close(); }
  }

  private database(): Promise<IDBDatabase> { return open(); }
}
