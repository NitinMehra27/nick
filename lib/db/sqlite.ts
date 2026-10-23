import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

/**
 * Opens (or creates) a SQLite database and applies pending migrations.
 * Migrations are additive and tracked with PRAGMA user_version, so startup
 * never drops or rewrites existing data.
 */
export function openDatabase(filePath: string, migrations: Migration[]): DB {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, migrations);
  return db;
}

export function migrate(db: DB, migrations: Migration[]): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = [...migrations].sort((a, b) => a.version - b.version).filter((m) => m.version > current);
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${Math.trunc(migration.version)}`);
    })();
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
