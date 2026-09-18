const DB_NAME = "kwook-outbox";
const STORE = "pending";

export interface OutboxRecord {
  id: string;
  table: string;
  payload: Record<string, unknown>;
  queuedAt: number;
  // A verdict the server passed on THIS row, which retrying cannot change. The
  // record STAYS: a refused measurement is still a measurement, and the owner is
  // owed both the fact that it was refused and the SQLSTATE that says why. What
  // the mark buys is that the row leaves the retry loop instead of being
  // re-POSTed every tick forever.
  rejectedAt?: number;
  rejectedCode?: string;
}

// "18 waiting" and "18 refused" are opposite situations - one needs a network,
// the other needs a person - and a single queue length cannot tell them apart.
export interface OutboxCounts {
  waiting: number;
  refused: number;
}

export interface FlushResult extends OutboxCounts {
  sent: number;
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

function allRecords(): Promise<OutboxRecord[]> {
  return tx("readonly", (s) => s.getAll() as IDBRequest<OutboxRecord[]>);
}

export const outbox = {
  add: (record: OutboxRecord) => tx("readwrite", (s) => s.put(record) as IDBRequest<IDBValidKey>),
  all: allRecords,
  remove: (id: string) => tx("readwrite", (s) => s.delete(id) as IDBRequest<undefined>),
  reject: async (id: string, code: string | undefined): Promise<void> => {
    const record = await tx("readonly", (s) => s.get(id) as IDBRequest<OutboxRecord | undefined>);
    if (!record) return;
    await tx(
      "readwrite",
      (s) =>
        s.put({ ...record, rejectedAt: Date.now(), rejectedCode: code }) as IDBRequest<IDBValidKey>,
    );
  },
};

// The verdicts behind the refused count, deduplicated. "42501" is something an
// owner can hand on and someone can fix; "3 minutes were refused" is not. Read
// separately from the counts because a refusal is rare and the codes are only
// worth a second pass over the queue when there is one to name.
export async function refusedCodes(): Promise<string[]> {
  const codes = new Set<string>();
  for (const record of await allRecords()) {
    if (record.rejectedCode !== undefined) codes.add(record.rejectedCode);
  }
  return [...codes];
}

function sqlstate(e: unknown): string | undefined {
  const code = e !== null && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

// Not every rejection is worth the same reaction. A PostgrestError carries a
// SQLSTATE in .code, which means the SERVER looked at the row and gave a
// verdict - retrying the identical row cannot change it. No code means the
// request never got a verdict (offline, timeout), which retrying can fix.
//
// 23505 unique_violation is the special case: it means this fact is already
// recorded. The id is derived from (device_id, minute) in src/lib/minuteRowId.ts
// and the table is unique on that pair, so a minute handed in twice is the SAME
// row - the server already has it, and our copy is DELIVERED in every sense that
// matters. This is also why a resynced camera cannot double-count: the database
// physically cannot hold one minute twice. Before this existed, that row sat at
// the head of the queue and blocked every record behind it forever.
//
// PGRST… codes are PostgREST's own, about the REQUEST rather than the row (an
// expired JWT, a cold schema cache). They are no verdict on a measurement, so
// they retry: a queue that visibly stops draining is recoverable, a measurement
// wrongly marked refused is not.
export type FlushVerdict = "delivered" | "poison" | "offline";

export function classifyFlushError(e: unknown): FlushVerdict {
  const code = sqlstate(e);
  if (code === undefined || code.startsWith("PGRST")) return "offline";
  if (code === "23505") return "delivered";
  return "poison";
}

// Drains what is on disk. Takes nothing but a sender: every record carries its
// own table and payload, so a phone with no open session - stopped, signed out,
// or reopened cold after a night offline - can still hand its queue in.
//
// One row's fate is not the queue's. A server verdict marks THAT row and the
// drain continues; only an unreachable backend stops the pass, because every
// record behind it would fail the same way.
export async function flush(
  send: (table: string, payload: Record<string, unknown>) => Promise<void>,
): Promise<FlushResult> {
  const pending = await allRecords();
  let sent = 0;
  let waiting = 0;
  let refused = 0;
  let unreachable = false;

  for (const record of pending) {
    if (record.rejectedAt !== undefined) {
      refused++;
      continue;
    }
    if (unreachable) {
      waiting++;
      continue;
    }
    try {
      await send(record.table, record.payload);
      await outbox.remove(record.id);
      sent++;
    } catch (e: unknown) {
      const verdict = classifyFlushError(e);
      if (verdict === "delivered") {
        await outbox.remove(record.id);
        sent++;
      } else if (verdict === "poison") {
        await outbox.reject(record.id, sqlstate(e));
        refused++;
      } else {
        unreachable = true;
        waiting++;
      }
    }
  }

  return { sent, waiting, refused };
}
