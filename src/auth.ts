import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyRequest } from 'fastify';
import { pool, one, withTx } from './db.js';
import { config, type KycTier } from './config.js';
import { conflict, unauthorized, forbidden } from './errors.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !n || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { ...SCRYPT, N: Number(n) });
  return timingSafeEqual(key, expected);
}

// A fixed hash used to keep login timing constant when the email is unknown.
const dummyHash = hashPassword('not-a-real-password');

export interface User {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  kycTier: KycTier;
  status: 'active' | 'frozen';
  createdAt: string;
}

const userCols = (t = '') =>
  `${t}id, ${t}email, ${t}handle, ${t}display_name AS "displayName", ${t}kyc_tier AS "kycTier", ${t}status, ${t}created_at AS "createdAt"`;
const USER_COLS = userCols();

export async function createUser(input: { email: string; handle: string; displayName: string; password: string }): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  return withTx(async (client) => {
    const existing = await one<{ email: string }>(client, 'SELECT email FROM users WHERE email = $1 OR handle = $2', [
      input.email,
      input.handle,
    ]);
    if (existing) {
      throw existing.email === input.email
        ? conflict('email_taken', 'An account with this email already exists')
        : conflict('handle_taken', 'That handle is taken');
    }
    const user = (await one<User>(
      client,
      `INSERT INTO users (email, handle, display_name, password_hash) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLS}`,
      [input.email, input.handle, input.displayName, passwordHash],
    ))!;
    await client.query(`INSERT INTO accounts (kind, user_id) VALUES ('user_wallet', $1)`, [user.id]);
    return user;
  });
}

export async function login(email: string, password: string): Promise<{ token: string; user: User } | null> {
  const row = await one<User & { password_hash: string }>(pool, `SELECT ${USER_COLS}, password_hash FROM users WHERE email = $1`, [
    email,
  ]);
  if (!row) {
    await verifyPassword(password, await dummyHash);
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) return null;
  const { password_hash: _, ...user } = row;
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hashToken(token), user.id, config.sessionTtlDays],
  );
  return { token, user };
}

export async function logout(token: string) {
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

const hashToken = (token: string) => createHash('sha256').update(token).digest();

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

export async function getUserById(id: string): Promise<User | undefined> {
  return one<User>(pool, `SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
}

/** Resolve the authenticated user from the Authorization header, or throw 401. */
export async function requireUser(req: FastifyRequest): Promise<User> {
  const token = bearer(req);
  if (!token) throw unauthorized();
  const user = await one<User>(
    pool,
    `SELECT ${userCols('u.')} FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  if (!user) throw unauthorized('Session expired or invalid');
  return user;
}

export async function requireActiveUser(req: FastifyRequest): Promise<User> {
  const user = await requireUser(req);
  if (user.status !== 'active') throw forbidden('account_frozen', 'This account is frozen. Contact support.');
  return user;
}

export function tokenFrom(req: FastifyRequest) {
  return bearer(req);
}
