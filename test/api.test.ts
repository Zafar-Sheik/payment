import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { pool } from '../src/db.js';
import { reconcile } from '../src/ledger.js';
import type { SandboxProvider } from '../src/providers/sandbox.js';
import { balance, call, deposit, key, register, setupApp, verify } from './helpers.js';

let app: FastifyInstance;
let provider: SandboxProvider;

beforeAll(async () => {
  ({ app, provider } = await setupApp());
});

afterAll(async () => {
  await provider.flush();
  const r = await reconcile(pool);
  // Every test leaves the books balanced.
  expect(r.ok).toBe(true);
  await app.close();
  await pool.end();
});

describe('auth', () => {
  it('registers, logs in and rejects bad credentials', async () => {
    const u = await register(app, 'auth');
    expect((await call(app, u, 'GET', '/api/me')).json().handle).toBe(u.handle);

    const ok = await call(app, null, 'POST', '/api/auth/login', { email: u.email, password: 'a-long-password' });
    expect(ok.statusCode).toBe(200);
    const bad = await call(app, null, 'POST', '/api/auth/login', { email: u.email, password: 'wrong-password' });
    expect(bad.statusCode).toBe(401);
    expect((await call(app, null, 'GET', '/api/wallet')).statusCode).toBe(401);
  });

  it('rejects duplicate handles and weak passwords', async () => {
    const u = await register(app, 'dup');
    const dup = await call(app, null, 'POST', '/api/auth/register', {
      email: 'other_' + u.email,
      handle: u.handle,
      displayName: 'X',
      password: 'a-long-password',
    });
    expect(dup.statusCode).toBe(409);
    const weak = await call(app, null, 'POST', '/api/auth/register', { email: 'w@example.com', handle: 'weakpw', displayName: 'W', password: 'short' });
    expect(weak.statusCode).toBe(400);
  });
});

describe('deposits', () => {
  it('credits the wallet only after the signed provider webhook', async () => {
    const u = await register(app, 'dep');
    const res = await call(app, u, 'POST', '/api/deposits', { amount: '250.00' });
    expect(res.json().status).toBe('pending');
    expect(await balance(app, u)).toBe('0.00');

    await provider.completeCheckout(res.json().reference, 'success');
    expect(await balance(app, u)).toBe('250.00');
    const deps = (await call(app, u, 'GET', '/api/deposits')).json();
    expect(deps[0].status).toBe('succeeded');
  });

  it('marks declined payments as failed without crediting', async () => {
    const u = await register(app, 'depfail');
    const { reference } = (await call(app, u, 'POST', '/api/deposits', { amount: '50' })).json();
    await provider.completeCheckout(reference, 'failed');
    expect(await balance(app, u)).toBe('0.00');
    expect((await call(app, u, 'GET', '/api/deposits')).json()[0].status).toBe('failed');
  });

  it('rejects webhooks with a bad signature', async () => {
    const payload = JSON.stringify({ event: 'charge.success', data: { reference: 'x', amount: '100', currency: 'ZAR', id: '1' } });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/sandbox',
      payload,
      headers: { 'content-type': 'application/json', 'x-sandbox-signature': 'deadbeef' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('ignores duplicate webhook deliveries and forged amounts', async () => {
    const u = await register(app, 'dedupe');
    const { reference } = (await call(app, u, 'POST', '/api/deposits', { amount: '100' })).json();
    await provider.completeCheckout(reference, 'success');

    // Replay a correctly signed event claiming a larger amount: the provider is
    // re-queried, and the deposit is already settled, so nothing changes.
    const payload = JSON.stringify({ event: 'charge.success', data: { reference, amount: '999900', currency: 'ZAR', id: 'replay' } });
    const sig = createHmac('sha512', 'test-sandbox-secret').update(payload).digest('hex');
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/sandbox',
        payload,
        headers: { 'content-type': 'application/json', 'x-sandbox-signature': sig },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(await balance(app, u)).toBe('100.00');
  });

  it('enforces the balance cap for unverified users', async () => {
    const u = await register(app, 'cap');
    const res = await call(app, u, 'POST', '/api/deposits', { amount: '5000.01' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('balance_limit_exceeded');
  });
});

describe('transfers', () => {
  it('moves money between users', async () => {
    const a = await register(app, 'alice');
    const b = await register(app, 'bob');
    await deposit(app, provider, a, '300');

    const res = await call(app, a, 'POST', '/api/transfers', { to: '@' + b.handle, amount: '120.50', note: 'lunch' }, key());
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ amount: '120.50', note: 'lunch', to: { handle: b.handle } });
    expect(await balance(app, a)).toBe('179.50');
    expect(await balance(app, b)).toBe('120.50');

    const activity = (await call(app, b, 'GET', '/api/activity')).json();
    expect(activity[0]).toMatchObject({ kind: 'transfer', amount: '120.50', counterparty: a.handle, note: 'lunch' });
  });

  it('can address the recipient by email', async () => {
    const a = await register(app, 'em');
    const b = await register(app, 'em');
    await deposit(app, provider, a, '10');
    const res = await call(app, a, 'POST', '/api/transfers', { to: b.email, amount: '10' }, key());
    expect(res.statusCode).toBe(201);
    expect(await balance(app, b)).toBe('10.00');
  });

  it('rejects insufficient funds, self-transfers and bad amounts', async () => {
    const a = await register(app, 'poor');
    const b = await register(app, 'poor');
    await deposit(app, provider, a, '10');

    const tooMuch = await call(app, a, 'POST', '/api/transfers', { to: b.handle, amount: '10.01' }, key());
    expect(tooMuch.statusCode).toBe(422);
    expect(tooMuch.json().error.code).toBe('insufficient_funds');

    const self = await call(app, a, 'POST', '/api/transfers', { to: a.handle, amount: '1' }, key());
    expect(self.statusCode).toBe(400);

    for (const amount of ['0', '-5', '1.001', 'abc']) {
      const r = await call(app, a, 'POST', '/api/transfers', { to: b.handle, amount }, key());
      expect(r.statusCode, amount).toBe(400);
    }
    expect(await balance(app, a)).toBe('10.00');
  });

  it('requires an idempotency key', async () => {
    const a = await register(app, 'nokey');
    const b = await register(app, 'nokey');
    const res = await call(app, a, 'POST', '/api/transfers', { to: b.handle, amount: '1' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('idempotency_key_required');
  });

  it('replays a retried request instead of paying twice', async () => {
    const a = await register(app, 'idem');
    const b = await register(app, 'idem');
    await deposit(app, provider, a, '100');
    const k = key();
    const first = await call(app, a, 'POST', '/api/transfers', { to: b.handle, amount: '40' }, k);
    const second = await call(app, a, 'POST', '/api/transfers', { to: b.handle, amount: '40' }, k);
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
    expect(await balance(app, a)).toBe('60.00');

    const reused = await call(app, a, 'POST', '/api/transfers', { to: b.handle, amount: '41' }, k);
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error.code).toBe('idempotency_key_reused');
  });

  it('handles concurrent duplicates of the same request exactly once', async () => {
    const a = await register(app, 'race1');
    const b = await register(app, 'race1');
    await deposit(app, provider, a, '100');
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call(app, a, 'POST', '/api/transfers', { to: b.handle, amount: '25' }, k)),
    );
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    expect(await balance(app, a)).toBe('75.00');
    expect(await balance(app, b)).toBe('25.00');
  });

  it('never overdraws under concurrent spending', async () => {
    const a = await register(app, 'race2');
    const recipients = await Promise.all(Array.from({ length: 4 }, () => register(app, 'race2r')));
    await deposit(app, provider, a, '500');

    // 20 concurrent R100 payments against a R500 balance: exactly 5 may succeed.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => call(app, a, 'POST', '/api/transfers', { to: recipients[i % 4]!.handle, amount: '100' }, key())),
    );
    const ok = results.filter((r) => r.statusCode === 201).length;
    const declined = results.filter((r) => r.statusCode === 422 && r.json().error.code === 'insufficient_funds').length;
    expect(ok).toBe(5);
    expect(declined).toBe(15);
    expect(await balance(app, a)).toBe('0.00');
    const received = await Promise.all(recipients.map((r) => balance(app, r)));
    expect(received.reduce((s, v) => s + Number(v), 0)).toBe(500);
  });

  it('enforces the daily send limit for unverified users', async () => {
    const a = await register(app, 'limit');
    const b = await register(app, 'limit');
    await deposit(app, provider, a, '1500');
    expect((await call(app, a, 'POST', '/api/transfers', { to: b.handle, amount: '900' }, key())).statusCode).toBe(201);
    const over = await call(app, a, 'POST', '/api/transfers', { to: b.handle, amount: '100.01' }, key());
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('daily_limit_exceeded');
    expect((await call(app, a, 'POST', '/api/transfers', { to: b.handle, amount: '100' }, key())).statusCode).toBe(201);
  });
});

describe('payment requests', () => {
  it('lets a payer pay a request exactly once', async () => {
    const requester = await register(app, 'req');
    const payer = await register(app, 'payer');
    await deposit(app, provider, payer, '200');

    const created = await call(app, requester, 'POST', '/api/requests', { from: payer.handle, amount: '75', note: 'tickets' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const incoming = (await call(app, payer, 'GET', '/api/requests')).json().incoming;
    expect(incoming[0]).toMatchObject({ id, status: 'pending', amount: '75.00' });

    // Requester cannot decline, stranger cannot see it.
    expect((await call(app, requester, 'POST', `/api/requests/${id}/decline`)).statusCode).toBe(403);
    const stranger = await register(app, 'stranger');
    expect((await call(app, stranger, 'POST', `/api/requests/${id}/pay`, undefined, key())).statusCode).toBe(404);

    const paid = await call(app, payer, 'POST', `/api/requests/${id}/pay`, undefined, key());
    expect(paid.statusCode).toBe(200);
    expect(paid.json().request.status).toBe('paid');

    const again = await call(app, payer, 'POST', `/api/requests/${id}/pay`, undefined, key());
    expect(again.statusCode).toBe(409);

    expect(await balance(app, payer)).toBe('125.00');
    expect(await balance(app, requester)).toBe('75.00');
  });

  it('supports decline and cancel', async () => {
    const requester = await register(app, 'rq2');
    const payer = await register(app, 'py2');
    const r1 = (await call(app, requester, 'POST', '/api/requests', { from: payer.handle, amount: '5' })).json();
    const r2 = (await call(app, requester, 'POST', '/api/requests', { from: payer.handle, amount: '6' })).json();
    expect((await call(app, payer, 'POST', `/api/requests/${r1.id}/decline`)).json().status).toBe('declined');
    expect((await call(app, requester, 'POST', `/api/requests/${r2.id}/cancel`)).json().status).toBe('cancelled');
    expect((await call(app, payer, 'POST', `/api/requests/${r2.id}/pay`, undefined, key())).statusCode).toBe(409);
  });
});

describe('identity verification', () => {
  it('raises limits and blocks reuse of the same ID number', async () => {
    const a = await register(app, 'kyc');
    const b = await register(app, 'kyc');
    const id = '8001015009087';
    const res = await call(app, a, 'POST', '/api/me/verify-identity', { idNumber: id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kycTier: 1, limits: { canWithdraw: true } });

    const reuse = await call(app, b, 'POST', '/api/me/verify-identity', { idNumber: id });
    expect(reuse.statusCode).toBe(409);

    const invalid = await call(app, b, 'POST', '/api/me/verify-identity', { idNumber: '8001015009088' });
    expect(invalid.statusCode).toBe(422);
  });
});

describe('withdrawals', () => {
  async function verifiedUserWithBank(accountNumber: string, funds = '1000') {
    const u = await register(app, 'wd');
    await verify(app, u);
    await deposit(app, provider, u, funds);
    const bank = await call(app, u, 'POST', '/api/bank-accounts', { bankCode: '470010', accountNumber, accountHolder: 'Test User' });
    expect(bank.statusCode).toBe(201);
    expect(bank.json().accountLast4).toBe(accountNumber.slice(-4));
    return { u, bankAccountId: bank.json().id as string };
  }

  it('requires identity verification', async () => {
    const u = await register(app, 'wdnokyc');
    const res = await call(app, u, 'POST', '/api/withdrawals', { bankAccountId: crypto.randomUUID(), amount: '10' }, key());
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('kyc_required');
  });

  it('pays out and settles on the provider webhook', async () => {
    const { u, bankAccountId } = await verifiedUserWithBank('1234567890');
    const res = await call(app, u, 'POST', '/api/withdrawals', { bankAccountId, amount: '200' }, key());
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ amount: '200.00', fee: '5.00', status: 'processing' });
    expect(await balance(app, u)).toBe('795.00');

    await provider.flush();
    expect((await call(app, u, 'GET', '/api/withdrawals')).json()[0].status).toBe('succeeded');
    expect(await balance(app, u)).toBe('795.00');
  });

  it('returns funds and fee when the bank bounces the payout', async () => {
    const { u, bankAccountId } = await verifiedUserWithBank('1234569999');
    await call(app, u, 'POST', '/api/withdrawals', { bankAccountId, amount: '300' }, key());
    expect(await balance(app, u)).toBe('695.00');
    await provider.flush();
    const [w] = (await call(app, u, 'GET', '/api/withdrawals')).json();
    expect(w).toMatchObject({ status: 'failed', failureReason: 'Account closed' });
    expect(await balance(app, u)).toBe('1000.00');
  });

  it('reverses immediately when the provider rejects the payout', async () => {
    const { u, bankAccountId } = await verifiedUserWithBank('1234560000');
    const res = await call(app, u, 'POST', '/api/withdrawals', { bankAccountId, amount: '100' }, key());
    expect(res.json().status).toBe('failed');
    expect(await balance(app, u)).toBe('1000.00');
  });

  it('does not double-submit on an idempotent retry', async () => {
    const { u, bankAccountId } = await verifiedUserWithBank('1234567891');
    const k = key();
    const a = await call(app, u, 'POST', '/api/withdrawals', { bankAccountId, amount: '50' }, k);
    const b = await call(app, u, 'POST', '/api/withdrawals', { bankAccountId, amount: '50' }, k);
    expect(b.json().id).toBe(a.json().id);
    await provider.flush();
    expect(await balance(app, u)).toBe('945.00');
    expect((await call(app, u, 'GET', '/api/withdrawals')).json()).toHaveLength(1);
  });

  it("cannot withdraw to someone else's bank account", async () => {
    const { bankAccountId } = await verifiedUserWithBank('1234567892');
    const thief = await register(app, 'thief');
    await verify(app, thief);
    const res = await call(app, thief, 'POST', '/api/withdrawals', { bankAccountId, amount: '1' }, key());
    expect(res.statusCode).toBe(404);
  });
});

describe('ledger integrity', () => {
  it('refuses unbalanced entries at the database level', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`INSERT INTO ledger_transactions (kind, description) VALUES ('transfer', 'bad') RETURNING id`);
      const acct = (await client.query(`SELECT id FROM accounts WHERE code = 'external_settlement'`)).rows[0].id;
      await client.query('INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after) VALUES ($1, $2, 100, 0)', [rows[0].id, acct]);
      await expect(client.query('COMMIT')).rejects.toThrow(/does not balance/);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('refuses edits to posted entries', async () => {
    await expect(pool.query('UPDATE ledger_entries SET amount = amount + 1 WHERE id = (SELECT min(id) FROM ledger_entries)')).rejects.toThrow(
      /append-only/,
    );
  });

  it('reconciles via the admin endpoint', async () => {
    expect((await call(app, null, 'GET', '/admin/reconciliation')).statusCode).toBe(403);
    const res = await app.inject({ method: 'GET', url: '/admin/reconciliation', headers: { authorization: 'Bearer test-admin-token' } });
    expect(res.json()).toMatchObject({ ok: true, ledgerSum: '0.00', balanceMismatches: [] });
    const { customerFunds, systemAccounts } = res.json();
    // Money held for customers + in-flight payouts + fees == money that came in, net of payouts.
    const held = Number(customerFunds) + Number(systemAccounts.withdrawals_pending) + Number(systemAccounts.fee_revenue);
    expect(held).toBeCloseTo(-Number(systemAccounts.external_settlement), 2);
  });
});
