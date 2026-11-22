import type { Migration } from "./migrations";

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: SqlValue[]): RunResult;
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

/**
 * The slice of a synchronous SQLite connection the services use. `node:sqlite` satisfies it on the
 * desktop; the browser debug build adapts sql.js to it.
 */
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

export function migrate(db: Database, migrations: Migration[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[]).map((row) => row.id),
  );
  for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
    if (applied.has(migration.id)) continue;
    transaction(db, () => {
      db.exec(migration.sql);
      migration.run?.(db);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
    });
  }
}

const txDepth = new WeakMap<Database, number>();

export function transaction<T>(db: Database, work: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  txDepth.set(db, depth + 1);
  if (depth === 0) db.exec("BEGIN IMMEDIATE");
  else db.exec(`SAVEPOINT km0_sp_${depth}`);
  try {
    const result = work();
    if (depth === 0) db.exec("COMMIT");
    else db.exec(`RELEASE SAVEPOINT km0_sp_${depth}`);
    return result;
  } catch (error) {
    if (depth === 0) db.exec("ROLLBACK");
    else {
      db.exec(`ROLLBACK TO SAVEPOINT km0_sp_${depth}`);
      db.exec(`RELEASE SAVEPOINT km0_sp_${depth}`);
    }
    throw error;
  } finally {
    if (depth === 0) txDepth.delete(db);
    else txDepth.set(db, depth);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
