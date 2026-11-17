import pg from 'pg';
import { config } from './config.js';

// Return BIGINT/NUMERIC columns as strings (the default) — we convert to
// bigint explicitly where they are money, never to JS numbers.

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 20 });

export type Db = pg.Pool | pg.PoolClient;

/**
 * Run `fn` inside a database transaction. Retries on serialization failures
 * and deadlocks, which Postgres may raise under concurrent load.
 */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const code = (err as { code?: string }).code;
      if ((code === '40001' || code === '40P01') && attempt < 5) {
        await new Promise((r) => setTimeout(r, 10 * attempt + Math.random() * 20));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function one<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const res = await db.query(sql, params);
  return res.rows[0] as T | undefined;
}

export async function many<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query(sql, params);
  return res.rows as T[];
}
