import type { PoolClient } from 'pg';
import { pool, one } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { formatAmount } from '../money.js';
import { sendMoney } from './transfers.js';

const SELECT = `
  SELECT r.id, r.amount::text, r.note, r.status, r.created_at AS "createdAt", r.updated_at AS "updatedAt",
         r.requester_id AS "requesterId", rq.handle AS "requesterHandle", rq.display_name AS "requesterName",
         r.payer_id AS "payerId", py.handle AS "payerHandle", py.display_name AS "payerName", r.transfer_id AS "transferId"
    FROM payment_requests r
    JOIN users rq ON rq.id = r.requester_id
    JOIN users py ON py.id = r.payer_id`;

type Row = {
  id: string;
  amount: string;
  note: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  requesterId: string;
  requesterHandle: string;
  requesterName: string;
  payerId: string;
  payerHandle: string;
  payerName: string;
  transferId: string | null;
};

const present = (r: Row) => ({
  id: r.id,
  amount: formatAmount(BigInt(r.amount)),
  currency: 'ZAR',
  note: r.note,
  status: r.status,
  requester: { id: r.requesterId, handle: r.requesterHandle, displayName: r.requesterName },
  payer: { id: r.payerId, handle: r.payerHandle, displayName: r.payerName },
  transferId: r.transferId,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export async function createRequest(input: { requesterId: string; payerId: string; amount: bigint; note?: string | null }) {
  if (input.requesterId === input.payerId) throw badRequest('self_request', 'You cannot request money from yourself');
  const pending = await one<{ n: string }>(
    pool,
    `SELECT count(*)::text AS n FROM payment_requests WHERE requester_id = $1 AND payer_id = $2 AND status = 'pending'`,
    [input.requesterId, input.payerId],
  );
  if (Number(pending!.n) >= 5) throw conflict('too_many_requests', 'You already have several open requests to this person');
  const { id } = (await one<{ id: string }>(
    pool,
    `INSERT INTO payment_requests (requester_id, payer_id, amount, note) VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.requesterId, input.payerId, input.amount.toString(), input.note?.trim() || null],
  ))!;
  return getRequest(pool, id);
}

async function getRequest(db: PoolClient | typeof pool, id: string) {
  const row = await one<Row>(db, `${SELECT} WHERE r.id = $1`, [id]);
  if (!row) throw notFound('Payment request not found');
  return present(row);
}

export async function listRequests(userId: string) {
  const rows = await pool.query<Row>(
    `${SELECT} WHERE r.requester_id = $1 OR r.payer_id = $1 ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 100`,
    [userId],
  );
  const all = rows.rows.map(present);
  return {
    incoming: all.filter((r) => r.payer.id === userId),
    outgoing: all.filter((r) => r.requester.id === userId),
  };
}

async function lockRequest(client: PoolClient, id: string) {
  const r = await one<{ requester_id: string; payer_id: string; amount: string; status: string; note: string | null }>(
    client,
    'SELECT requester_id, payer_id, amount::text, status, note FROM payment_requests WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!r) throw notFound('Payment request not found');
  return r;
}

/** Pay a request. Runs inside an idempotent transaction supplied by the caller. */
export async function payRequest(client: PoolClient, userId: string, id: string) {
  const r = await lockRequest(client, id);
  if (r.payer_id !== userId) throw notFound('Payment request not found');
  if (r.status !== 'pending') throw conflict('request_not_pending', `This request is already ${r.status}`);
  const transfer = await sendMoney(client, {
    senderId: userId,
    recipientId: r.requester_id,
    amount: BigInt(r.amount),
    note: r.note,
    paymentRequestId: id,
  });
  await client.query(`UPDATE payment_requests SET status = 'paid', transfer_id = $2, updated_at = now() WHERE id = $1`, [id, transfer.id]);
  return { request: await getRequest(client, id), transfer };
}

export async function closeRequest(client: PoolClient, userId: string, id: string, action: 'decline' | 'cancel') {
  const r = await lockRequest(client, id);
  const allowed = action === 'decline' ? r.payer_id === userId : r.requester_id === userId;
  if (!allowed) {
    if (r.payer_id === userId || r.requester_id === userId) {
      throw forbidden('not_allowed', action === 'decline' ? 'Only the payer can decline a request' : 'Only the requester can cancel a request');
    }
    throw notFound('Payment request not found');
  }
  if (r.status !== 'pending') throw conflict('request_not_pending', `This request is already ${r.status}`);
  await client.query(`UPDATE payment_requests SET status = $2, updated_at = now() WHERE id = $1`, [
    id,
    action === 'decline' ? 'declined' : 'cancelled',
  ]);
  return getRequest(client, id);
}
