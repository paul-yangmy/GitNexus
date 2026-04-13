/**
 * SQLite-backed user management for the GitNexus Platform.
 * Uses crypto.scrypt for secure password hashing.
 */

import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { query } from './db.js';

export interface PlatformUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: string;
  created_at: string;
  updated_at: string;
}

const SCRYPT_KEYLEN = 64;

function toUser(row: UserRow): PlatformUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

function verifyPassword(password: string, stored: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return resolve(false);
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(crypto.timingSafeEqual(Buffer.from(hash, 'hex'), derivedKey));
    });
  });
}

export async function createUser(opts: {
  username: string;
  password: string;
  displayName: string;
  role?: string;
}): Promise<PlatformUser> {
  const passwordHash = await hashPassword(opts.password);
  const id = randomUUID();
  const result = query(
    `INSERT INTO users (id, username, display_name, password_hash, role)
     VALUES (?, ?, ?, ?, ?)
     RETURNING *`,
    [id, opts.username, opts.displayName, passwordHash, opts.role ?? 'user'],
  );
  return toUser(result.rows[0] as unknown as UserRow);
}

export async function authenticateUser(
  username: string,
  password: string,
): Promise<PlatformUser | null> {
  const result = query('SELECT * FROM users WHERE username = ?', [username]);
  const row = result.rows[0] as unknown as UserRow | undefined;
  if (!row) return null;

  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return null;

  return toUser(row);
}

export async function getUserById(id: string): Promise<PlatformUser | null> {
  const result = query('SELECT * FROM users WHERE id = ?', [id]);
  const row = result.rows[0] as unknown as UserRow | undefined;
  return row ? toUser(row) : null;
}

export async function listUsers(): Promise<PlatformUser[]> {
  const result = query('SELECT * FROM users ORDER BY created_at');
  return result.rows.map((r) => toUser(r as unknown as UserRow));
}

export async function seedAdminUser(): Promise<void> {
  const result = query('SELECT COUNT(*) AS count FROM users');
  const count = parseInt(String((result.rows[0] as Record<string, unknown>)['count'] ?? '0'), 10);
  if (count > 0) return;

  const admin = await createUser({
    username: 'admin',
    password: process.env.ADMIN_PASSWORD ?? 'admin123!@#',
    displayName: 'Administrator',
    role: 'admin',
  });

  console.log('\n[platform-auth] Initial admin account created');
  console.log(`  username: admin`);
  console.log(`  password: ${process.env.ADMIN_PASSWORD ?? 'admin123!@#'}`);
  console.log(`  id: ${admin.id}`);
  console.log('  Please change this password after first login.\n');
}
