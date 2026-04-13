/**
 * SQLite database layer for the GitNexus Platform (via better-sqlite3).
 *
 * DB path resolution order:
 *   1. PLATFORM_DB_PATH env var (absolute path to .db file)
 *   2. <cwd>/platform.db  (local dev default)
 *
 * For Docker, mount a host directory and set PLATFORM_DB_PATH=/data/platform.db
 */

import BetterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH =
  process.env.PLATFORM_DB_PATH ??
  path.resolve(process.cwd(), 'platform.db');

let db: BetterSqlite3.Database | null = null;

function getDb(): BetterSqlite3.Database {
  if (!db) {
    // Ensure parent directory exists
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new BetterSqlite3(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    console.log(`[platform-db] SQLite opened: ${DB_PATH}`);
  }
  return db;
}

/** pg-compatible result shape so callers don't need changes. */
export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

/**
 * Execute a SQL statement.
 * Uses `?` placeholders (SQLite style).
 * Statements with SELECT or RETURNING use `.all()` to return rows.
 */
export function query(text: string, params: unknown[] = []): QueryResult {
  const database = getDb();
  const stmt = database.prepare(text);
  const returnsRows = /^\s*(SELECT|WITH|PRAGMA)/i.test(text) || /\bRETURNING\b/i.test(text);
  if (returnsRows) {
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return { rows, rowCount: rows.length };
  } else {
    const info = stmt.run(...params);
    return { rows: [], rowCount: info.changes };
  }
}

/** Run the bundled schema.sql to create tables (idempotent via IF NOT EXISTS). */
export function initializeDatabase(): void {
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf-8');
  getDb().exec(sql);
  console.log('[platform-db] Schema applied');
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
