import { DatabaseSync } from "node:sqlite";
import { migrations as defaultMigrations, type Migration } from "./migrations";
import { type Database, migrate } from "./sql";

export type { Database } from "./sql";
export { migrate, nowIso, transaction } from "./sql";

/** Opens (or creates) the KM0 database and brings its schema up to date. */
export function openDatabase(path: string, migrations: Migration[] = defaultMigrations): Database {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db, migrations);
  return db;
}
