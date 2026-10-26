import { readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations as defaultMigrations, type Migration } from "./migrations";
import { type Database, migrate } from "./sql";

export type { Database } from "./sql";
export { migrate, nowIso, transaction } from "./sql";

/** Backups kept next to the database; older ones are removed. */
const KEEP_BACKUPS = 3;

/**
 * Before migrations change an existing database, copy it next to itself as
 * `km0.db.before-<n>-<time>.bak`, n being the last migration it had. `VACUUM INTO` writes a consistent copy
 * even with WAL. Returns the backup's path, or null when there was nothing to back up.
 */
export function backupBeforeMigrating(db: DatabaseSync, path: string, migrations: Migration[]): string | null {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!hasTable) return null;
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[]).map((row) => row.id),
  );
  if (applied.size === 0 || migrations.every((migration) => applied.has(migration.id))) return null;
  const last = Math.max(...applied);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${path}.before-${last}-${stamp}.bak`;
  db.prepare("VACUUM INTO ?").run(target);
  const prefix = `${basename(path)}.before-`;
  const backups = readdirSync(dirname(path))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) rmSync(join(dirname(path), old));
  return target;
}

/** Opens (or creates) the KM0 database and brings its schema up to date, backing it up first when it changes. */
export function openDatabase(path: string, migrations: Migration[] = defaultMigrations): Database {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") backupBeforeMigrating(db, path, migrations);
  migrate(db, migrations);
  return db;
}
