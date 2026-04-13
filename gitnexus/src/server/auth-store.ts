import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { getGlobalDir } from '../storage/repo-manager.js';

export type AuthRole = 'admin' | 'user';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: AuthRole;
  createdAt: string;
}

interface StoredUserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: AuthRole;
  created_at: string;
}

const AUTH_DB_PATH = path.join(getGlobalDir(), 'auth.sqlite');
const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = '1qa#ED5tg&UJ';

let db: Database.Database | null = null;

export const getAuthDbPath = (): string => AUTH_DB_PATH;

const getDb = (): Database.Database => {
  if (db) return db;

  fs.mkdirSync(path.dirname(AUTH_DB_PATH), { recursive: true });
  db = new Database(AUTH_DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );
  `);

  const count =
    (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number } | undefined)
      ?.count ?? 0;

  if (count === 0) {
    const createdAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, role, created_at)
       VALUES (@id, @username, @display_name, @password_hash, @role, @created_at)`,
    ).run({
      id: crypto.randomUUID(),
      username: DEFAULT_ADMIN_USERNAME,
      display_name: 'Administrator',
      password_hash: hashPassword(DEFAULT_ADMIN_PASSWORD),
      role: 'admin',
      created_at: createdAt,
    });

    console.log('\n[product-auth] Initial admin account created');
    console.log(`  username: ${DEFAULT_ADMIN_USERNAME}`);
    console.log(`  password: ${DEFAULT_ADMIN_PASSWORD}`);
    console.log('  Please log in and change or rotate this password after first use.\n');
  }

  return db;
};

const toAuthUser = (row: Pick<StoredUserRow, 'id' | 'username' | 'display_name' | 'role' | 'created_at'>): AuthUser => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  role: row.role,
  createdAt: row.created_at,
});

const hashPassword = (password: string): string => {
  return crypto.createHash('sha256').update(password).digest('hex');
};

export const initializeAuthStore = (): void => {
  getDb();
  console.log(`[product-auth] sqlite path: ${AUTH_DB_PATH}`);
};

export const authenticateUser = (
  username: string,
  password: string,
): { token: string; user: AuthUser } | null => {
  const database = getDb();
  const row = database
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username) as StoredUserRow | undefined;

  if (!row || row.password_hash !== hashPassword(password)) {
    return null;
  }

  const token = crypto.randomBytes(32).toString('hex');
  database
    .prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
    .run(token, row.id, new Date().toISOString());

  return { token, user: toAuthUser(row) };
};

export const getUserBySessionToken = (token: string): AuthUser | null => {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .get(token) as
    | Pick<StoredUserRow, 'id' | 'username' | 'display_name' | 'role' | 'created_at'>
    | undefined;

  return row ? toAuthUser(row) : null;
};

export const deleteSession = (token: string): void => {
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
};

export const listUsers = (): AuthUser[] => {
  const rows = getDb()
    .prepare('SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at DESC')
    .all() as Array<Pick<StoredUserRow, 'id' | 'username' | 'display_name' | 'role' | 'created_at'>>;
  return rows.map(toAuthUser);
};

export const createUser = (input: {
  username: string;
  password: string;
  displayName?: string;
  role?: AuthRole;
}): AuthUser => {
  const database = getDb();
  const username = input.username.trim();
  const password = input.password.trim();
  const displayName = input.displayName?.trim() || username;
  const role: AuthRole = input.role === 'admin' ? 'admin' : 'user';

  if (!username || !password) {
    throw new Error('Username and password are required');
  }

  const existing = database
    .prepare('SELECT id FROM users WHERE username = ?')
    .get(username) as { id: string } | undefined;
  if (existing) {
    throw new Error('Username already exists');
  }

  const row = {
    id: crypto.randomUUID(),
    username,
    display_name: displayName,
    password_hash: hashPassword(password),
    role,
    created_at: new Date().toISOString(),
  };

  database
    .prepare(
      `INSERT INTO users (id, username, display_name, password_hash, role, created_at)
       VALUES (@id, @username, @display_name, @password_hash, @role, @created_at)`,
    )
    .run(row);

  return toAuthUser(row);
};
