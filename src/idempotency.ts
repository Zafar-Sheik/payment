import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FastifyRequest } from 'fastify';
import { withTx, one } from './db.js';
import { ApiError, badRequest, unprocessable } from './errors.js';

export interface StoredResponse {
  status: number;
  body: unknown;
}

export function idempotencyKey(req: FastifyRequest): string {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 100) {
    throw badRequest('idempotency_key_required', 'An Idempotency-Key header (8-100 chars, e.g. a UUID) is required');
  }
  return key;
}

/**
 * Execute a money-moving operation at most once per (user, key).
 *
 * The key row is inserted in the same database transaction as the operation,
 * so either both commit or neither does. A concurrent request with the same
 * key blocks on the unique index until the first commits, then replays its
 * stored response. Business errors (ApiError) are stored and replayed too;
 * unexpected errors roll everything back so the client can safely retry.
 */
export async function runIdempotent(
  userId: string,
  key: string,
  request: unknown,
  op: (client: PoolClient) => Promise<StoredResponse>,
): Promise<StoredResponse> {
  const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  return withTx(async (client) => {
    const inserted = await client.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash, response_status, response_body)
       VALUES ($1, $2, $3, 0, 'null') ON CONFLICT DO NOTHING`,
      [userId, key, requestHash],
    );
    if (inserted.rowCount === 0) {
      const prior = (await one<{ request_hash: string; response_status: number; response_body: unknown }>(
        client,
        'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
        [userId, key],
      ))!;
      if (prior.request_hash !== requestHash) {
        throw unprocessable('idempotency_key_reused', 'This Idempotency-Key was already used with a different request');
      }
      return { status: prior.response_status, body: prior.response_body };
    }

    let result: StoredResponse;
    await client.query('SAVEPOINT idem_op');
    try {
      result = await op(client);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      await client.query('ROLLBACK TO SAVEPOINT idem_op');
      result = { status: err.status, body: err.toBody() };
    }
    await client.query('UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE user_id = $1 AND key = $2', [
      userId,
      key,
      result.status,
      JSON.stringify(result.body),
    ]);
    return result;
  });
}
