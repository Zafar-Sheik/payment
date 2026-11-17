import { randomBytes } from 'node:crypto';
import { pool, one, many, withTx } from '../db.js';
import { config } from '../config.js';
import { postTransaction, systemAccountId, walletIdForUser, getBalance } from '../ledger.js';
import { formatAmount } from '../money.js';
import type { User } from '../auth.js';
import type { PaymentProvider } from '../providers/types.js';
import { assertCanHold } from './limits.js';

type DepositRow = {
  id: string;
  amount: string;
  status: string;
  reference: string;
  checkout_url: string | null;
  failure_reason: string | null;
  created_at: string;
};

const present = (d: DepositRow) => ({
  id: d.id,
  amount: formatAmount(BigInt(d.amount)),
  currency: 'ZAR',
  status: d.status,
  reference: d.reference,
  checkoutUrl: d.status === 'pending' ? d.checkout_url : null,
  failureReason: d.failure_reason,
  createdAt: d.created_at,
});

/** Start a wallet top-up: create a pending deposit and a hosted checkout at the provider. */
export async function createDeposit(provider: PaymentProvider, user: User, amount: bigint) {
  const walletId = await walletIdForUser(pool, user.id);
  assertCanHold(user.kycTier, await getBalance(pool, walletId), amount, 'you');

  const reference = `dep_${randomBytes(12).toString('hex')}`;
  const row = (await one<DepositRow>(
    pool,
    `INSERT INTO deposits (user_id, amount, provider, reference) VALUES ($1, $2, $3, $4) RETURNING *`,
    [user.id, amount.toString(), provider.name, reference],
  ))!;

  try {
    const { checkoutUrl } = await provider.createCheckout({
      reference,
      amount,
      email: user.email,
      callbackUrl: `${config.PUBLIC_URL}/?deposit=${reference}`,
    });
    const updated = (await one<DepositRow>(pool, `UPDATE deposits SET checkout_url = $2, updated_at = now() WHERE id = $1 RETURNING *`, [
      row.id,
      checkoutUrl,
    ]))!;
    return present(updated);
  } catch (err) {
    await pool.query(`UPDATE deposits SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`, [
      row.id,
      'Could not start checkout',
    ]);
    throw err;
  }
}

export async function listDeposits(userId: string) {
  return (await many<DepositRow>(pool, `SELECT * FROM deposits WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId])).map(present);
}

/**
 * Credit a wallet once the provider confirms the charge. Idempotent: the
 * deposit row is locked and only a pending deposit can be credited.
 */
export async function settleDeposit(reference: string, confirmed: { amount: bigint; currency: string }) {
  return withTx(async (client) => {
    const dep = await one<{ id: string; user_id: string; amount: string; status: string }>(
      client,
      'SELECT id, user_id, amount::text, status FROM deposits WHERE reference = $1 FOR UPDATE',
      [reference],
    );
    if (!dep) return { outcome: 'unknown_reference' as const };
    if (dep.status !== 'pending') return { outcome: 'already_processed' as const };

    if (confirmed.currency !== 'ZAR' || confirmed.amount !== BigInt(dep.amount)) {
      // Never credit a mismatched amount automatically — flag for manual review.
      await client.query(`UPDATE deposits SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`, [
        dep.id,
        `Amount mismatch: expected ${dep.amount} ZAR cents, provider reported ${confirmed.amount} ${confirmed.currency}`,
      ]);
      return { outcome: 'mismatch' as const };
    }

    const transactionId = await postTransaction(client, {
      kind: 'deposit',
      description: 'Wallet top-up',
      metadata: { depositId: dep.id, reference },
      entries: [
        { accountId: await systemAccountId(client, 'external_settlement'), amount: -confirmed.amount },
        { accountId: await walletIdForUser(client, dep.user_id), amount: confirmed.amount },
      ],
    });
    await client.query(`UPDATE deposits SET status = 'succeeded', transaction_id = $2, updated_at = now() WHERE id = $1`, [
      dep.id,
      transactionId,
    ]);
    return { outcome: 'credited' as const };
  });
}

export async function failDeposit(reference: string, reason: string) {
  await pool.query(`UPDATE deposits SET status = 'failed', failure_reason = $2, updated_at = now() WHERE reference = $1 AND status = 'pending'`, [
    reference,
    reason,
  ]);
}
