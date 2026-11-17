import { pool, one, withTx, type Db } from '../db.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { ageOn, hashIdNumber, validateSaIdNumber } from '../kyc.js';
import { getUserById, type User } from '../auth.js';
import { config, tierLimits } from '../config.js';
import { formatAmount } from '../money.js';

export interface PublicUser {
  id: string;
  handle: string;
  displayName: string;
}

/** Find a user by "@handle", "handle" or email. */
export async function findRecipient(db: Db, identifier: string): Promise<PublicUser & { status: string; kycTier: number }> {
  const id = identifier.trim().toLowerCase();
  const user = id.includes('@') && !id.startsWith('@')
    ? await one<PublicUser & { status: string; kycTier: number }>(
        db,
        `SELECT id, handle, display_name AS "displayName", status, kyc_tier AS "kycTier" FROM users WHERE email = $1`,
        [id],
      )
    : await one<PublicUser & { status: string; kycTier: number }>(
        db,
        `SELECT id, handle, display_name AS "displayName", status, kyc_tier AS "kycTier" FROM users WHERE handle = $1`,
        [id.replace(/^@/, '')],
      );
  if (!user) throw notFound('No user found with that handle or email');
  return user;
}

export function describeUser(user: User) {
  const limits = tierLimits[user.kycTier];
  return {
    id: user.id,
    email: user.email,
    handle: user.handle,
    displayName: user.displayName,
    kycTier: user.kycTier,
    status: user.status,
    limits: {
      maxBalance: formatAmount(limits.maxBalance),
      dailySend: formatAmount(limits.dailySend),
      canWithdraw: limits.canWithdraw,
      withdrawalFee: formatAmount(config.withdrawalFee),
    },
    createdAt: user.createdAt,
  };
}

/**
 * Upgrade a user to tier 1 using their SA ID number.
 *
 * SANDBOX ONLY: this checks the number's structure and checksum, and blocks
 * duplicates. In production you must verify the identity against the
 * Department of Home Affairs via a KYC vendor (e.g. Smile ID, VerifyNow,
 * Onfido), with a selfie/liveness check, before granting tier 1.
 */
export async function verifyIdentity(userId: string, idNumber: string) {
  const result = validateSaIdNumber(idNumber);
  if (!result.valid) throw unprocessable('invalid_id_number', result.reason);
  if (ageOn(result.dateOfBirth) < 18) throw unprocessable('underage', 'You must be 18 or older to verify your account');

  const idHash = hashIdNumber(idNumber);
  await withTx(async (client) => {
    const other = await one(client, 'SELECT 1 FROM users WHERE id_number_hash = $1 AND id <> $2', [idHash, userId]);
    if (other) throw conflict('identity_in_use', 'This ID number is already linked to another account');
    await client.query('UPDATE users SET id_number_hash = $2, kyc_tier = GREATEST(kyc_tier, 1) WHERE id = $1', [userId, idHash]);
  });
  return describeUser((await getUserById(userId))!);
}

export async function activity(userId: string, limit = 50) {
  const rows = await pool.query(
    `SELECT e.id, t.id AS "transactionId", t.kind, t.description, t.metadata, e.amount::text, e.balance_after::text AS "balanceAfter", e.created_at AS "createdAt"
       FROM ledger_entries e
       JOIN accounts a ON a.id = e.account_id
       JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE a.user_id = $1
      ORDER BY e.id DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows.rows.map((r) => ({
    transactionId: r.transactionId,
    kind: r.kind,
    description: r.description,
    counterparty:
      r.kind === 'transfer' ? (BigInt(r.amount) < 0n ? r.metadata?.recipientHandle : r.metadata?.senderHandle) ?? null : null,
    note: r.metadata?.note ?? null,
    amount: formatAmount(BigInt(r.amount)),
    balanceAfter: formatAmount(BigInt(r.balanceAfter)),
    createdAt: r.createdAt,
  }));
}
