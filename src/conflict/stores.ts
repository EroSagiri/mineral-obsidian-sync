import type { ConflictRecord, ConflictStore, MergeBaseRecord, MergeBaseStore, ResolutionIntent, ResolutionIntentStore } from "./types";
/**
 * Conflict-resolution persistence.
 *
 * A dedicated IndexedDB database, not an extension of the previous-state store: `previous` is the
 * device's only record of what it has already synchronized, and a schema migration there risks the
 * baseline that all deletion and conflict inference depends on. These stores are additive state whose
 * worst case, when lost, is "a conflict has to be re-detected" or "a merge falls back to manual".
 *
 * Nothing here is sync truth, so every write is best-effort at the call site: a failed merge-base
 * write must never fail a successful R2 transfer.
 */
const DATABASE = "r2-personal-sync-conflicts-v1";
const MERGE_BASE = "merge-base";
const CONFLICTS = "conflicts";
const INTENTS = "resolution-intents";

/** Bounded so a long-lived vault cannot grow this store without limit. */
export const MAX_MERGE_BASE_RECORDS_PER_CHANNEL = 2000;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MERGE_BASE)) db.createObjectStore(MERGE_BASE, { keyPath: ["channel", "path"] });
      if (!db.objectStoreNames.contains(CONFLICTS)) {
        const store = db.createObjectStore(CONFLICTS, { keyPath: ["channel", "conflictId"] });
        store.createIndex("byChannel", "channel");
      }
      if (!db.objectStoreNames.contains(INTENTS)) {
        const store = db.createObjectStore(INTENTS, { keyPath: ["channel", "conflictId"] });
        store.createIndex("byChannel", "channel");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open the conflict store"));
  });
}

function transaction<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result: T;
    let settled = false;
    tx.oncomplete = () => { if (!settled) { settled = true; resolve(result); } };
    tx.onerror = () => { if (!settled) { settled = true; reject(tx.error ?? new Error("conflict store transaction failed")); } };
    tx.onabort = () => { if (!settled) { settled = true; reject(tx.error ?? new Error("conflict store transaction aborted")); } };
    Promise.resolve(run(tx)).then((value) => { result = value; }).catch((error) => { if (!settled) { settled = true; reject(error); } });
  });
}

const request = <T>(source: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  source.onsuccess = () => resolve(source.result);
  source.onerror = () => reject(source.error ?? new Error("conflict store request failed"));
});

/** Reads every record of a store for one channel, via the channel index. */
function perChannel<T>(db: IDBDatabase, storeName: string, channel: string): Promise<T[]> {
  return transaction(db, [storeName], "readonly", async (tx) => {
    const index = tx.objectStore(storeName).index("byChannel");
    return request(index.getAll(channel) as IDBRequest<T[]>);
  });
}

export class IndexedDbConflictStores implements MergeBaseStore, ConflictStore, ResolutionIntentStore {
  private database(): Promise<IDBDatabase> { return open(); }

  // ---- merge base -------------------------------------------------------------------------------

  async get(channel: string, path: string): Promise<MergeBaseRecord | undefined> {
    const db = await this.database();
    try {
      return await transaction(db, [MERGE_BASE], "readonly", async (tx) => request(tx.objectStore(MERGE_BASE).get([channel, path]) as IDBRequest<MergeBaseRecord | undefined>));
    } finally { db.close(); }
  }

  async getMany(channel: string, paths: readonly string[]): Promise<Map<string, MergeBaseRecord>> {
    if (!paths.length) return new Map();
    const db = await this.database();
    try {
      return await transaction(db, [MERGE_BASE], "readonly", async (tx) => {
        const store = tx.objectStore(MERGE_BASE);
        const records = await Promise.all(paths.map(async (path) => [path, await request(store.get([channel, path]) as IDBRequest<MergeBaseRecord | undefined>)] as const));
        return new Map(records.filter((entry): entry is readonly [string, MergeBaseRecord] => entry[1] !== undefined));
      });
    } finally { db.close(); }
  }

  async put(record: MergeBaseRecord): Promise<void> {
    const db = await this.database();
    try { await transaction(db, [MERGE_BASE], "readwrite", (tx) => { tx.objectStore(MERGE_BASE).put(record); }); }
    finally { db.close(); }
  }

  async putMany(records: readonly MergeBaseRecord[]): Promise<void> {
    if (!records.length) return;
    const db = await this.database();
    try {
      await transaction(db, [MERGE_BASE], "readwrite", (tx) => {
        const store = tx.objectStore(MERGE_BASE);
        for (const record of records) store.put(record);
      });
    } finally { db.close(); }
  }

  async remove(channel: string, paths: string[]): Promise<void> {
    if (!paths.length) return;
    const db = await this.database();
    try {
      await transaction(db, [MERGE_BASE], "readwrite", (tx) => {
        const store = tx.objectStore(MERGE_BASE);
        for (const path of paths) store.delete([channel, path]);
      });
    } finally { db.close(); }
  }

  /** Keeps the newest `maxRecords` snapshots for a channel and forgets the rest. */
  async prune(channel: string, maxRecords: number): Promise<void> {
    const db = await this.database();
    try {
      const all = await perChannel<MergeBaseRecord>(db, MERGE_BASE, channel);
      if (all.length <= maxRecords) return;
      const doomed = all.sort((left, right) => right.updatedAt - left.updatedAt).slice(maxRecords);
      await transaction(db, [MERGE_BASE], "readwrite", (tx) => {
        const store = tx.objectStore(MERGE_BASE);
        for (const record of doomed) store.delete([record.channel, record.path]);
      });
    } finally { db.close(); }
  }

  // ---- conflicts --------------------------------------------------------------------------------

  listConflicts(channel: string): Promise<ConflictRecord[]> { return this.database().then(async (db) => { try { return await perChannel<ConflictRecord>(db, CONFLICTS, channel); } finally { db.close(); } }); }

  async getConflict(channel: string, conflictId: string): Promise<ConflictRecord | undefined> {
    const db = await this.database();
    try {
      return await transaction(db, [CONFLICTS], "readonly", async (tx) => request(tx.objectStore(CONFLICTS).get([channel, conflictId]) as IDBRequest<ConflictRecord | undefined>));
    } finally { db.close(); }
  }

  async putConflict(record: ConflictRecord): Promise<void> {
    const db = await this.database();
    try { await transaction(db, [CONFLICTS], "readwrite", (tx) => { tx.objectStore(CONFLICTS).put(record); }); }
    finally { db.close(); }
  }

  async removeConflicts(channel: string, conflictIds: string[]): Promise<void> {
    if (!conflictIds.length) return;
    const db = await this.database();
    try {
      await transaction(db, [CONFLICTS], "readwrite", (tx) => {
        const store = tx.objectStore(CONFLICTS);
        for (const conflictId of conflictIds) store.delete([channel, conflictId]);
      });
    } finally { db.close(); }
  }

  /**
   * Retains only records that are still active. `active` maps a path to its *current* conflict id, so
   * a record for the same path with an older identity is dropped: the disagreement it described no
   * longer exists in that form.
   */
  async reconcile(channel: string, active: Map<string, string>): Promise<void> {
    const db = await this.database();
    try {
      const existing = await perChannel<ConflictRecord>(db, CONFLICTS, channel);
      const doomed = existing.filter((record) => active.get(record.path) !== record.conflictId);
      if (!doomed.length) return;
      await transaction(db, [CONFLICTS], "readwrite", (tx) => {
        const store = tx.objectStore(CONFLICTS);
        for (const record of doomed) store.delete([record.channel, record.conflictId]);
      });
    } finally { db.close(); }
  }

  // ---- resolution intents -----------------------------------------------------------------------

  listIntents(channel: string): Promise<ResolutionIntent[]> { return this.database().then(async (db) => { try { return await perChannel<ResolutionIntent>(db, INTENTS, channel); } finally { db.close(); } }); }

  async putIntent(intent: ResolutionIntent): Promise<void> {
    const db = await this.database();
    try { await transaction(db, [INTENTS], "readwrite", (tx) => { tx.objectStore(INTENTS).put(intent); }); }
    finally { db.close(); }
  }

  async removeIntents(channel: string, conflictIds: string[]): Promise<void> {
    if (!conflictIds.length) return;
    const db = await this.database();
    try {
      await transaction(db, [INTENTS], "readwrite", (tx) => {
        const store = tx.objectStore(INTENTS);
        for (const conflictId of conflictIds) store.delete([channel, conflictId]);
      });
    } finally { db.close(); }
  }
}

export function createMemoryConflictStores(): MemoryConflictStores {
  const mergeBase = new Map<string, MergeBaseRecord>();
  const conflicts = new Map<string, ConflictRecord>();
  const intents = new Map<string, ResolutionIntent>();
  const key = (channel: string, id: string) => `${channel}\u0000${id}`;
  return {
    mergeBase, conflicts, intents,
    get: async (channel: string, path: string) => mergeBase.get(key(channel, path)),
    getMany: async (channel: string, paths: readonly string[]) => new Map(paths.flatMap((path) => {
      const record = mergeBase.get(key(channel, path));
      return record ? [[path, record] as const] : [];
    })),
    put: async (record: MergeBaseRecord) => { mergeBase.set(key(record.channel, record.path), record); },
    putMany: async (records: readonly MergeBaseRecord[]) => { for (const record of records) mergeBase.set(key(record.channel, record.path), record); },
    remove: async (channel: string, paths: string[]) => { for (const path of paths) mergeBase.delete(key(channel, path)); },
    prune: async (channel: string, maxRecords: number) => {
      const mine = [...mergeBase.values()].filter((record) => record.channel === channel);
      if (mine.length <= maxRecords) return;
      for (const record of mine.sort((left, right) => right.updatedAt - left.updatedAt).slice(maxRecords)) mergeBase.delete(key(channel, record.path));
    },
    listConflicts: async (channel: string) => [...conflicts.values()].filter((record) => record.channel === channel),
    getConflict: async (channel: string, conflictId: string) => conflicts.get(key(channel, conflictId)),
    putConflict: async (record: ConflictRecord) => { conflicts.set(key(record.channel, record.conflictId), record); },
    removeConflicts: async (channel: string, conflictIds: string[]) => { for (const id of conflictIds) conflicts.delete(key(channel, id)); },
    reconcile: async (channel: string, active: Map<string, string>) => {
      for (const record of [...conflicts.values()]) {
        if (record.channel !== channel) continue;
        if (active.get(record.path) !== record.conflictId) conflicts.delete(key(channel, record.conflictId));
      }
    },
    listIntents: async (channel: string) => [...intents.values()].filter((intent) => intent.channel === channel),
    putIntent: async (intent: ResolutionIntent) => { intents.set(key(intent.channel, intent.conflictId), intent); },
    removeIntents: async (channel: string, conflictIds: string[]) => { for (const id of conflictIds) intents.delete(key(channel, id)); },
  };
}

/** In-memory implementation for tests; the shape mirrors the IndexedDB one exactly. */
export interface MemoryConflictStores extends MergeBaseStore, ConflictStore, ResolutionIntentStore {
  mergeBase: Map<string, MergeBaseRecord>;
  conflicts: Map<string, ConflictRecord>;
  intents: Map<string, ResolutionIntent>;
}
