import type { HotStateStore } from "./store";

/** Identity belongs to this installation, never to the synchronised plugin settings. */
export function deviceHotClientId(storage: { read(): unknown; write(value: string): void }, generate = () => crypto.randomUUID()): string {
  const previous = storage.read();
  if (typeof previous === "string" && /^[0-9a-f-]{36}$/i.test(previous)) return previous;
  const id = generate();
  storage.write(id);
  return id;
}

/** Retain every owed CRDT update while moving legacy sessions to the installation's identity. */
export async function migrateHotClientIdentity(store: HotStateStore, clientId: string): Promise<void> {
  // Persist outbox ownership first. A crash before session migration is repaired on the next start.
  // The Yjs update and operation id remain unchanged; replay is idempotent at the CRDT boundary.
  for (const entry of await store.loadOutbox()) {
    if (entry.clientId !== clientId) await store.putOutbox({ ...entry, clientId });
  }
  for (const session of await store.loadSessions()) {
    if (session.clientId !== clientId) await store.putSession({ ...session, clientId });
  }
}
