const DB_NAME = "kwook-outbox";
const STORE = "pending";

export interface OutboxRecord {
  id: string;
  table: string;
  payload: Record<string, unknown>;
  queuedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const request = fn(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const outbox = {
  add: (record: OutboxRecord) => tx("readwrite", (s) => s.put(record) as IDBRequest<IDBValidKey>),
  all: () => tx("readonly", (s) => s.getAll() as IDBRequest<OutboxRecord[]>),
  remove: (id: string) => tx("readwrite", (s) => s.delete(id) as IDBRequest<undefined>),
  count: () => tx("readonly", (s) => s.count() as IDBRequest<number>),
};

// Records are keyed by a client-generated id and written with upsert, so a
// retry after a dropped connection can never double-count.
export async function flush(
  send: (table: string, payload: Record<string, unknown>) => Promise<void>,
): Promise<number> {
  const pending = await outbox.all();
  let sent = 0;
  for (const record of pending) {
    try {
      await send(record.table, record.payload);
      await outbox.remove(record.id);
      sent++;
    } catch {
      break;
    }
  }
  return sent;
}
