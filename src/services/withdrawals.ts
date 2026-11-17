import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, one, many, withTx } from '../db.js';
import { config, tierLimits } from '../config.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { lockAccounts, postTransaction, systemAccountId, walletIdForUser } from '../ledger.js';
import { formatAmount } from '../money.js';
import type { User } from '../auth.js';
import { ProviderRejectedError, type PaymentProvider } from '../providers/types.js';
import { assertCanSend } from './limits.js';

/*
 * Withdrawal lifecycle
 *
 *   pending     funds moved wallet -> withdrawals_pending (+ fee); not yet sent to provider
 *   processing  claimed and submitted to the provider; waiting for its webhook
 *   succeeded   provider confirmed: withdrawals_pending -> external_settlement
 *   failed      provider rejected / bank bounced: everything returned to the wallet
 *
 * If the provider call fails ambiguously (timeout, 5xx) the withdrawal stays
 * `processing` — we never assume a payout failed unless the provider says so,
 * otherwise a retry could pay the user twice. Such rows show up in the admin
 * reconciliation report for an operator to resolve.
 */

type BankRow = {
  id: string;
  bank_code: string;
  bank_name: string;
  account_holder: string;
  account_last4: string;
  recipient_code: string;
  provider: string;
  created_at: string;
};

const presentBank = (b: BankRow) => ({
  id: b.id,
  bankCode: b.bank_code,
  bankName: b.bank_name,
  accountHolder: b.account_holder,
  accountLast4: b.account_last4,
  createdAt: b.created_at,
});

export async function addBankAccount(
  provider: PaymentProvider,
  user: User,
  input: { bankCode: string; accountNumber: string; accountHolder: string },
) {
  const banks = await provider.listBanks();
  const bank = banks.find((b) => b.code === input.bankCode);
  if (!bank) throw badRequest('unknown_bank', 'Unknown bank');
  const count = await one<{ n: string }>(pool, 'SELECT count(*)::text AS n FROM bank_accounts WHERE user_id = $1', [user.id]);
  if (Number(count!.n) >= 5) throw badRequest('too_many_bank_accounts', 'You can link at most 5 bank accounts');

  let recipientCode: string;
  try {
    ({ recipientCode } = await provider.createRecipient({ name: input.accountHolder, accountNumber: input.accountNumber, bankCode: bank.code }));
  } catch (err) {
    if (err instanceof ProviderRejectedError) throw badRequest('bank_account_rejected', err.message);
    throw err;
  }
  const row = (await one<BankRow>(
    pool,
    `INSERT INTO bank_accounts (user_id, bank_code, bank_name, account_holder, account_last4, provider, recipient_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [user.id, bank.code, bank.name, input.accountHolder, input.accountNumber.slice(-4), provider.name, recipientCode],
  ))!;
  return presentBank(row);
}

export async function listBankAccounts(userId: string) {
  return (await many<BankRow>(pool, 'SELECT * FROM bank_accounts WHERE user_id = $1 ORDER BY created_at', [userId])).map(presentBank);
}

type WithdrawalRow = {
  id: string;
  amount: string;
  fee: string;
  status: string;
  reference: string;
  failure_reason: string | null;
  created_at: string;
  bank_name?: string;
  account_last4?: string;
};

const presentWithdrawal = (w: WithdrawalRow) => ({
  id: w.id,
  amount: formatAmount(BigInt(w.amount)),
  fee: formatAmount(BigInt(w.fee)),
  currency: 'ZAR',
  status: w.status,
  reference: w.reference,
  destination: w.bank_name ? `${w.bank_name} ••${w.account_last4}` : undefined,
  failureReason: w.failure_reason,
  createdAt: w.created_at,
});

/** Step 1 (inside an idempotent transaction): reserve the funds. */
export async function createWithdrawal(client: PoolClient, user: User, input: { bankAccountId: string; amount: bigint }) {
  if (!tierLimits[user.kycTier].canWithdraw) {
    throw forbidden('kyc_required', 'Verify your identity before withdrawing to a bank account');
  }
  const bank = await one<BankRow>(client, 'SELECT * FROM bank_accounts WHERE id = $1 AND user_id = $2', [input.bankAccountId, user.id]);
  if (!bank) throw notFound('Bank account not found');

  const fee = config.withdrawalFee;
  const walletId = await walletIdForUser(client, user.id);
  await lockAccounts(client, [walletId]);
  await assertCanSend(client, walletId, user.kycTier, input.amount + fee);

  const reference = `wd_${randomBytes(12).toString('hex')}`;
  const holdTx = await postTransaction(client, {
    kind: 'withdrawal',
    description: `Withdrawal to ${bank.bank_name} ••${bank.account_last4}`,
    metadata: { reference, fee: fee.toString() },
    entries: [
      { accountId: walletId, amount: -(input.amount + fee) },
      { accountId: await systemAccountId(client, 'withdrawals_pending'), amount: input.amount },
      { accountId: await systemAccountId(client, 'fee_revenue'), amount: fee },
    ],
  });
  const row = (await one<WithdrawalRow>(
    client,
    `INSERT INTO withdrawals (user_id, bank_account_id, amount, fee, provider, reference, hold_transaction_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [user.id, bank.id, input.amount.toString(), fee.toString(), bank.provider, reference, holdTx],
  ))!;
  return presentWithdrawal({ ...row, bank_name: bank.bank_name, account_last4: bank.account_last4 });
}

/** Step 2 (after commit): submit to the provider exactly once. */
export async function dispatchWithdrawal(provider: PaymentProvider, withdrawalId: string) {
  const claimed = await one<{ reference: string; amount: string; recipient_code: string }>(
    pool,
    `UPDATE withdrawals w SET status = 'processing', updated_at = now()
       FROM bank_accounts b
      WHERE w.id = $1 AND w.status = 'pending' AND b.id = w.bank_account_id
      RETURNING w.reference, w.amount::text, b.recipient_code`,
    [withdrawalId],
  );
  if (!claimed) return; // already dispatched (e.g. an idempotent replay)

  try {
    await provider.initiatePayout({
      reference: claimed.reference,
      amount: BigInt(claimed.amount),
      recipientCode: claimed.recipient_code,
      reason: 'Wallet withdrawal',
    });
  } catch (err) {
    if (err instanceof ProviderRejectedError) {
      await reverseWithdrawal(claimed.reference, err.message);
    } else {
      console.error(`[withdrawals] outcome unknown for ${claimed.reference}; left in processing for reconciliation`, err);
    }
  }
}

export async function settleWithdrawal(reference: string) {
  return withTx(async (client) => {
    const w = await one<{ id: string; amount: string; status: string }>(
      client,
      'SELECT id, amount::text, status FROM withdrawals WHERE reference = $1 FOR UPDATE',
      [reference],
    );
    if (!w || !['pending', 'processing'].includes(w.status)) return false;
    const amount = BigInt(w.amount);
    const tx = await postTransaction(client, {
      kind: 'withdrawal_settled',
      description: 'Withdrawal paid out',
      metadata: { reference },
      entries: [
        { accountId: await systemAccountId(client, 'withdrawals_pending'), amount: -amount },
        { accountId: await systemAccountId(client, 'external_settlement'), amount },
      ],
    });
    await client.query(`UPDATE withdrawals SET status = 'succeeded', final_transaction_id = $2, updated_at = now() WHERE id = $1`, [w.id, tx]);
    return true;
  });
}

export async function reverseWithdrawal(reference: string, reason: string) {
  return withTx(async (client) => {
    const w = await one<{ id: string; user_id: string; amount: string; fee: string; status: string }>(
      client,
      'SELECT id, user_id, amount::text, fee::text, status FROM withdrawals WHERE reference = $1 FOR UPDATE',
      [reference],
    );
    if (!w || !['pending', 'processing'].includes(w.status)) return false;
    const amount = BigInt(w.amount);
    const fee = BigInt(w.fee);
    const tx = await postTransaction(client, {
      kind: 'withdrawal_reversal',
      description: 'Withdrawal failed — funds returned',
      metadata: { reference, reason },
      entries: [
        { accountId: await systemAccountId(client, 'withdrawals_pending'), amount: -amount },
        { accountId: await systemAccountId(client, 'fee_revenue'), amount: -fee },
        { accountId: await walletIdForUser(client, w.user_id), amount: amount + fee },
      ],
    });
    await client.query(
      `UPDATE withdrawals SET status = 'failed', failure_reason = $3, final_transaction_id = $2, updated_at = now() WHERE id = $1`,
      [w.id, tx, reason],
    );
    return true;
  });
}

export async function listWithdrawals(userId: string) {
  return (
    await many<WithdrawalRow>(
      pool,
      `SELECT w.*, b.bank_name, b.account_last4 FROM withdrawals w JOIN bank_accounts b ON b.id = w.bank_account_id
        WHERE w.user_id = $1 ORDER BY w.created_at DESC LIMIT 50`,
      [userId],
    )
  ).map(presentWithdrawal);
}

export async function getWithdrawal(userId: string, id: string) {
  const row = await one<WithdrawalRow>(
    pool,
    `SELECT w.*, b.bank_name, b.account_last4 FROM withdrawals w JOIN bank_accounts b ON b.id = w.bank_account_id
      WHERE w.user_id = $1 AND w.id = $2`,
    [userId, id],
  );
  if (!row) throw notFound('Withdrawal not found');
  return presentWithdrawal(row);
}

export async function stuckWithdrawals() {
  return many<{ reference: string; status: string; amount: string; updated_at: string }>(
    pool,
    `SELECT reference, status, amount::text, updated_at FROM withdrawals
      WHERE status IN ('pending', 'processing') AND updated_at < now() - interval '1 hour' ORDER BY updated_at`,
  );
}
