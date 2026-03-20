/**
 * Schema migration runner for the ClawChats plugin SQLite database.
 *
 * - Tracks schema version in a `_schema_version` table
 * - Runs migrations sequentially from current version to target
 * - Creates a backup before migrating (if not `:memory:` and currentVersion > 0)
 * - Wraps all migrations in a transaction with rollback on error
 */

import * as fs from 'node:fs';
import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

interface Migration {
  version: number;
  up: (db: Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    up: (db: Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          session_key TEXT UNIQUE NOT NULL,
          title TEXT DEFAULT 'New chat',
          pinned INTEGER DEFAULT 0,
          pin_order INTEGER DEFAULT 0,
          model TEXT,
          last_session_id TEXT,
          sort_order INTEGER DEFAULT 0,
          unread_count INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT DEFAULT 'sent',
          metadata TEXT,
          seq INTEGER,
          timestamp INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_dedup ON messages(thread_id, role, timestamp);

        CREATE TABLE IF NOT EXISTS unread_messages (
          thread_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (thread_id, message_id),
          FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_unread_thread ON unread_messages(thread_id);

        CREATE VIRTUAL TABLE messages_fts USING fts5(
          content, content=messages, content_rowid=rowid,
          tokenize='porter unicode61'
        );

        CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
      `);
    },
  },
];

/**
 * Run all pending migrations against the given database.
 *
 * Safe to call on every startup — exits early if already up to date.
 */
export function runMigrations(db: Database): void {
  // Ensure the version-tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_version (
      version INTEGER NOT NULL
    );
  `);

  // Read the current schema version (0 = fresh database)
  const row = (db.prepare('SELECT version FROM _schema_version LIMIT 1').get() as { version: number } | undefined);
  const currentVersion: number = row?.version ?? 0;

  if (currentVersion >= SCHEMA_VERSION) {
    return;
  }

  // Create a backup before migrating an existing database
  const dbPath: string = db.name;
  if (currentVersion > 0 && dbPath !== ':memory:') {
    const backupPath = `${dbPath}.backup-v${currentVersion}`;
    fs.copyFileSync(dbPath, backupPath);
  }

  // Run all pending migrations inside a single transaction
  const migrate = db.transaction(() => {
    for (const migration of migrations) {
      if (migration.version > currentVersion) {
        migration.up(db);
      }
    }

    // Record the new schema version
    if (row === undefined) {
      db.prepare('INSERT INTO _schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    } else {
      db.prepare('UPDATE _schema_version SET version = ?').run(SCHEMA_VERSION);
    }
  });

  try {
    migrate();
  } catch (err) {
    // better-sqlite3 transactions automatically roll back on throw
    throw err;
  }
}
