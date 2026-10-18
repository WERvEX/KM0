import type { Database as SqlJsDatabase, SqlJsStatic } from "sql.js";
import type { Database, RunResult, SqlValue, Statement } from "../main/db/sql";

/** Where the browser build keeps its database file. */
export interface BlobStore {
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<void>;
}

const SAVE_DELAY_MS = 300;

/**
 * Adapts sql.js (SQLite compiled to WebAssembly) to the synchronous `Database` interface the services
 * use. The whole file lives in memory and is written back to `store` shortly after each change.
 */
export class SqlJsAdapter implements Database {
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly db: SqlJsDatabase,
    private readonly store: BlobStore,
  ) {
    this.applyPragmas();
  }

  static async open(sql: SqlJsStatic, store: BlobStore): Promise<SqlJsAdapter> {
    const bytes = await store.load();
    return new SqlJsAdapter(new sql.Database(bytes ?? undefined), store);
  }

  exec(sql: string): void {
    this.db.exec(sql);
    this.markDirty();
  }

  prepare(sql: string): Statement {
    return {
      run: (...params) => this.run(sql, params),
      get: (...params) => this.query(sql, params, true)[0],
      all: (...params) => this.query(sql, params, false),
    };
  }

  close(): void {
    void this.flush();
  }

  /** Write pending changes now, e.g. when the page is hidden. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    // export() closes and reopens the connection, which resets per-connection pragmas.
    const bytes = this.db.export();
    this.applyPragmas();
    await this.store.save(bytes);
  }

  private run(sql: string, params: SqlValue[]): RunResult {
    this.db.run(sql, bind(params));
    const changes = this.db.getRowsModified();
    const rowid = this.db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0];
    this.markDirty();
    return { changes, lastInsertRowid: typeof rowid === "number" ? rowid : 0 };
  }

  private query(sql: string, params: SqlValue[], first: boolean): Record<string, unknown>[] {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(bind(params));
      const rows: Record<string, unknown>[] = [];
      while (statement.step()) {
        rows.push(statement.getAsObject());
        if (first) break;
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  private applyPragmas(): void {
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  private markDirty(): void {
    this.dirty = true;
    // Transactions run synchronously, so a deferred save never lands in the middle of one.
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }
}

function bind(params: SqlValue[]): (string | number | null | Uint8Array)[] {
  return params.map((value) => (typeof value === "bigint" ? Number(value) : value));
}

/** Keeps one blob in IndexedDB. */
export function indexedDbStore(databaseName: string): BlobStore {
  const STORE = "files";
  const KEY = "km0.db";
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const withStore = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>) => {
    const idb = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = work(idb.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      idb.close();
    }
  };
  return {
    load: async () => {
      const value = await withStore<unknown>("readonly", (store) => store.get(KEY));
      return value instanceof Uint8Array ? value : null;
    },
    save: async (bytes) => {
      await withStore("readwrite", (store) => store.put(bytes, KEY));
    },
  };
}

/** Deletes the browser build's stored data. */
export function clearIndexedDbStore(databaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}
