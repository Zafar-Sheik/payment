import type { PoolClient } from 'pg';
import { one, many, type Db } from './db.js';
import { ApiError } from './errors.js';

export type SystemAccount = 'external_settlement' | 'withdrawals_pending' | 'fee_revenue';

export type LedgerKind = 'transfer' | 'deposit' | 'withdrawal' | 'withdrawal_settled' | 'withdrawal_reversal';

export interface Entry {
  accountId: string;
  amount: bigint;
}

export interface LockedAccount {
  id: string;
  userId: string | null;
  balance: bigint;
  allowNegative: boolean;
}

const systemIds = new Map<SystemAccount, string>();

export async function systemAccountId(db: Db, code: SystemAccount): Promise<string> {
  const cached = systemIds.get(code);
  if (cached) return cached;
  const row = await one<{ id: string }>(db, 'SELECT id FROM accounts WHERE code = $1', [code]);
  if (!row) throw new Error(`System account ${code} missing — did migrations run?`);
  systemIds.set(code, row.id);
  return row.id;
}

export async function walletIdForUser(db: Db, userId: string): Promise<string> {
  const row = await one<{ id: string }>(db, `SELECT id FROM accounts WHERE kind = 'user_wallet' AND user_id = $1`, [userId]);
  if (!row) throw new Error(`Wallet for user ${userId} missing`);
  return row.id;
}

/**
 * Lock accounts FOR UPDATE in a consistent (id) order, so concurrent
 * transactions touching the same accounts cannot deadlock. Returns current
 * balances. Must be called inside a transaction.
 */
export async function lockAccounts(client: PoolClient, ids: string[]): Promise<Map<string, LockedAccount>> {
  const unique = [...new Set(ids)].sort();
  const rows = await many<{ id: string; user_id: string | null; balance: string; allow_negative: boolean }>(
    client,
    'SELECT id, user_id, balance, allow_negative FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [unique],
  );
  if (rows.length !== unique.length) throw new Error('Unknown account in ledger operation');
  return new Map(
    rows.map((r) => [r.id, { id: r.id, userId: r.user_id, balance: BigInt(r.balance), allowNegative: r.allow_negative }]),
  );
}

/**
 * Post a balanced, immutable ledger transaction. This is the only code path
 * that changes account balances.
 */
export async function postTransaction(
  client: PoolClient,
  tx: { kind: LedgerKind; description: string; metadata?: Record<string, unknown>; entries: Entry[] },
): Promise<string> {
  const entries = tx.entries.filter((e) => e.amount !== 0n);
  if (entries.length < 2) throw new Error('A ledger transaction needs at least two non-zero entries');
  const sum = entries.reduce((s, e) => s + e.amount, 0n);
  if (sum !== 0n) throw new Error(`Ledger transaction does not balance (sum=${sum})`);

  const accounts = await lockAccounts(client, entries.map((e) => e.accountId));

  // Compute resulting balances (an account may appear in multiple entries).
  const running = new Map([...accounts].map(([id, a]) => [id, a.balance]));
  const balanceAfter: bigint[] = [];
  for (const e of entries) {
    const next = running.get(e.accountId)! + e.amount;
    running.set(e.accountId, next);
    balanceAfter.push(next);
  }
  for (const [id, bal] of running) {
    if (bal < 0n && !accounts.get(id)!.allowNegative) {
      throw new ApiError(422, 'insufficient_funds', 'Insufficient funds');
    }
  }

  const { id: txId } = (await one<{ id: string }>(
    client,
    'INSERT INTO ledger_transactions (kind, description, metadata) VALUES ($1, $2, $3) RETURNING id',
    [tx.kind, tx.description, JSON.stringify(tx.metadata ?? {})],
  ))!;

  await client.query(
    `INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
     SELECT $1, a, m::bigint, b::bigint FROM unnest($2::uuid[], $3::text[], $4::text[]) AS t(a, m, b)`,
    [txId, entries.map((e) => e.accountId), entries.map((e) => e.amount.toString()), balanceAfter.map(String)],
  );

  for (const [id, bal] of running) {
    if (bal !== accounts.get(id)!.balance) {
      await client.query('UPDATE accounts SET balance = $2 WHERE id = $1', [id, bal.toString()]);
    }
  }
  return txId;
}

export async function getBalance(db: Db, accountId: string): Promise<bigint> {
  const row = await one<{ balance: string }>(db, 'SELECT balance FROM accounts WHERE id = $1', [accountId]);
  return BigInt(row!.balance);
}

/**
 * Full reconciliation: the ledger must sum to zero, and every account's cached
 * balance must equal the sum of its entries.
 */
export async function reconcile(db: Db) {
  const total = await one<{ total: string }>(db, 'SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger_entries');
  const mismatches = await many<{ id: string; balance: string; computed: string }>(
    db,
    `SELECT a.id, a.balance::text, COALESCE(SUM(e.amount), 0)::text AS computed
       FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
      GROUP BY a.id HAVING a.balance <> COALESCE(SUM(e.amount), 0)`,
  );
  const system = await many<{ code: string; balance: string }>(
    db,
    `SELECT code, balance::text FROM accounts WHERE kind = 'system' ORDER BY code`,
  );
  const wallets = await one<{ total: string }>(
    db,
    `SELECT COALESCE(SUM(balance), 0)::text AS total FROM accounts WHERE kind = 'user_wallet'`,
  );
  return {
    ok: BigInt(total!.total) === 0n && mismatches.length === 0,
    ledgerSum: BigInt(total!.total),
    mismatches,
    systemAccounts: Object.fromEntries(system.map((s) => [s.code, BigInt(s.balance)])),
    customerFunds: BigInt(wallets!.total),
  };
}
