/** Where this device keeps its copy of the journal and the Garmin readings.
 * The browser uses IndexedDB: localStorage holds only about 5 MB, shared by every page on
 * xingkai03.github.io, and the offline journal keeps up to three copies of years of entries. */
export interface JournalStore {
  /** The stored value, or undefined when there is none. */
  get(key: string): Promise<unknown>;
  /** Writes every pair together: in one transaction where the store supports it. Otherwise a failed
   * write leaves the first key as it was and the rest missing. */
  set(entries: readonly [key: string, value: unknown][]): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
}
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

/** JSON in a Web Storage area. Used where IndexedDB is unavailable, and by the tests. */
export function storageJournalStore(storage: StorageLike): JournalStore {
  return {
    async get(key) {
      const encoded = storage.getItem(key);
      return encoded === null ? undefined : JSON.parse(encoded);
    },
    async set(entries) {
      // Without transactions, clear the later keys first: if a write fails part way, the first value
      // keeps its previous content and the later ones read as missing, never as stale.
      for (const [key] of entries.slice(1)) storage.removeItem(key);
      for (const [key, value] of entries) storage.setItem(key, JSON.stringify(value));
    },
    async remove(keys) { for (const key of keys) storage.removeItem(key); },
  };
}

const DATABASE = 'calories';
const OBJECTS = 'device';

/** IndexedDB, reading journals saved in localStorage by earlier builds until their next write moves them. */
export function indexedJournalStore(factory: IDBFactory, legacy?: StorageLike): JournalStore {
  const fallback = legacy ? storageJournalStore(legacy) : undefined;
  let opening: Promise<IDBDatabase | null> | null = null;
  function open(): Promise<IDBDatabase | null> {
    opening ??= new Promise<IDBDatabase | null>(resolve => {
      let request: IDBOpenDBRequest;
      try { request = factory.open(DATABASE, 1); } catch { resolve(null); return; }
      request.onupgradeneeded = () => { request.result.createObjectStore(OBJECTS); };
      request.onsuccess = () => {
        const database = request.result;
        // Let a newer build upgrade the database; this tab reopens it on its next read or write.
        database.onversionchange = () => { database.close(); opening = null; };
        resolve(database);
      };
      // Some private windows refuse IndexedDB; keep working from localStorage there.
      request.onerror = () => resolve(null);
    });
    return opening;
  }
  function run<T>(database: IDBDatabase, mode: IDBTransactionMode, action: (objects: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(OBJECTS, mode);
      const request = action(transaction.objectStore(OBJECTS));
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage failed.'));
    });
  }
  return {
    async get(key) {
      const database = await open();
      if (!database) return fallback?.get(key);
      const value = await run(database, 'readonly', objects => objects.get(key));
      return value !== undefined ? value : fallback?.get(key);
    },
    async set(entries) {
      const database = await open();
      if (!database) {
        if (!fallback) throw new Error('Browser storage is unavailable.');
        return fallback.set(entries);
      }
      await run(database, 'readwrite', objects => { for (const [key, value] of entries) objects.put(value, key); });
      // The IndexedDB copy now wins; drop the old one to free the shared localStorage space.
      try { for (const [key] of entries) legacy?.removeItem(key); } catch { /* A stale legacy copy is never read again. */ }
    },
    async remove(keys) {
      const database = await open();
      if (database) await run(database, 'readwrite', objects => { for (const key of keys) objects.delete(key); });
      for (const key of keys) legacy?.removeItem(key);
    },
  };
}

/** IndexedDB when the browser has it, and asks the browser not to evict it under storage pressure. */
export function browserJournalStore(local: StorageLike | undefined): JournalStore | undefined {
  if (typeof indexedDB === 'undefined') return local ? storageJournalStore(local) : undefined;
  if (typeof navigator !== 'undefined') navigator.storage?.persist?.().catch(() => {});
  return indexedJournalStore(indexedDB, local);
}
