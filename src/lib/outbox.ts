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

// Not every rejection is worth the same reaction. A PostgrestError carries a
// SQLSTATE in .code, which means the SERVER looked at the row and gave a
// verdict - retrying the identical row cannot change it. No code means the
// request never got a verdict (offline, timeout), which retrying can fix.
//
// 23505 unique_violation is the special case: it means this fact is already
// recorded. Two phones signed into the same device account both counting the
// same minute hit `unique (device_id, minute)` - the first writer wins and the
// loser's row is DELIVERED in every sense that matters, not failed. Before this
// existed, that loser sat at the head of the queue and blocked every record
// behind it forever.
export type FlushVerdict = "delivered" | "poison" | "offline";

export function classifyFlushError(e: unknown): FlushVerdict {
  const code = e !== null && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  if (code === "23505") return "delivered";
  if (typeof code === "string" && code.length > 0) return "poison";
  return "offline";
}

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
    } catch (e: unknown) {
      const verdict = classifyFlushError(e);
      if (verdict === "delivered") {
        // Another session for this device already wrote this row. The count is
        // recorded; drop our copy so the queue drains.
        await outbox.remove(record.id);
        sent++;
      } else if (verdict === "poison") {
      } else {
        // Offline: the backend is unreachable, so everything behind this
        // record would fail too. Stop and retry the whole queue later.
        break;
      }
    }
  }
  return sent;
}
