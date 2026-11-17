import type { PoolClient } from 'pg';
import { one } from '../db.js';
import { config, tierLimits, type KycTier } from '../config.js';
import { ApiError, unprocessable } from '../errors.js';
import { formatAmount } from '../money.js';

const SA_DAY_START = `(date_trunc('day', now() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg')`;

/**
 * Enforce outflow limits for a user. Call only while holding the lock on the
 * user's wallet (see ledger.lockAccounts) so concurrent requests serialise.
 */
export async function assertCanSend(client: PoolClient, walletId: string, tier: KycTier, amount: bigint) {
  const velocity = await one<{ n: string }>(
    client,
    `SELECT count(*)::text AS n FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE e.account_id = $1 AND e.amount < 0 AND t.kind = 'transfer' AND e.created_at > now() - interval '1 hour'`,
    [walletId],
  );
  if (Number(velocity!.n) >= config.maxTransfersPerHour) {
    throw new ApiError(429, 'velocity_limit', 'Too many payments in the last hour. Please try again later.');
  }

  const sent = await one<{ total: string }>(
    client,
    `SELECT COALESCE(-SUM(e.amount), 0)::text AS total FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE e.account_id = $1 AND e.amount < 0 AND t.kind IN ('transfer', 'withdrawal') AND e.created_at >= ${SA_DAY_START}`,
    [walletId],
  );
  const limit = tierLimits[tier].dailySend;
  if (BigInt(sent!.total) + amount > limit) {
    throw unprocessable(
      'daily_limit_exceeded',
      `This would exceed your daily limit of R${formatAmount(limit)}. Verify your identity to raise it.`,
    );
  }
}

export function assertCanHold(tier: KycTier, currentBalance: bigint, incoming: bigint, who: 'you' | 'recipient') {
  const max = tierLimits[tier].maxBalance;
  if (currentBalance + incoming > max) {
    throw unprocessable(
      who === 'you' ? 'balance_limit_exceeded' : 'recipient_limit_exceeded',
      who === 'you'
        ? `Your wallet can hold at most R${formatAmount(max)} at your verification level`
        : 'The recipient cannot receive this amount right now',
    );
  }
}
