import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import { config } from './config.js';
import { pool, withTx } from './db.js';
import { ApiError, forbidden, unauthorized } from './errors.js';
import { createUser, login, logout, requireActiveUser, requireUser, tokenFrom } from './auth.js';
import { amountSchema, formatAmount } from './money.js';
import { getBalance, reconcile, walletIdForUser } from './ledger.js';
import { idempotencyKey, runIdempotent } from './idempotency.js';
import { createProvider, SandboxProvider, type PaymentProvider } from './providers/index.js';
import { activity, describeUser, findRecipient, verifyIdentity } from './services/users.js';
import { sendMoney } from './services/transfers.js';
import { closeRequest, createRequest, listRequests, payRequest } from './services/requests.js';
import { createDeposit, listDeposits } from './services/deposits.js';
import {
  addBankAccount,
  createWithdrawal,
  dispatchWithdrawal,
  getWithdrawal,
  listBankAccounts,
  listWithdrawals,
  stuckWithdrawals,
} from './services/withdrawals.js';
import { processWebhook } from './services/webhooks.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const note = z.string().trim().max(140).optional().nullable();
const uuid = z.string().uuid();

const schemas = {
  register: z.object({
    email: z.string().trim().toLowerCase().email().max(254),
    handle: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,20}$/, 'Handle must be 3-20 letters, numbers or underscores'),
    displayName: z.string().trim().min(1).max(80),
    password: z.string().min(10, 'Password must be at least 10 characters').max(200),
  }),
  login: z.object({ email: z.string().trim().toLowerCase(), password: z.string() }),
  transfer: z.object({ to: z.string().trim().min(1).max(254), amount: amountSchema, note }),
  request: z.object({ from: z.string().trim().min(1).max(254), amount: amountSchema, note }),
  deposit: z.object({ amount: amountSchema }),
  kyc: z.object({ idNumber: z.string().trim().regex(/^\d{13}$/, 'ID number must be 13 digits') }),
  bankAccount: z.object({
    bankCode: z.string().trim().min(1).max(20),
    accountNumber: z.string().trim().regex(/^\d{6,16}$/, 'Account number must be 6-16 digits'),
    accountHolder: z.string().trim().min(2).max(100),
  }),
  withdrawal: z.object({ bankAccountId: uuid, amount: amountSchema }),
};

const send = (reply: FastifyReply, r: { status: number; body: unknown }) => reply.code(r.status).send(r.body);

export async function buildApp(opts: { provider?: PaymentProvider; logger?: boolean; rateLimit?: boolean } = {}): Promise<FastifyInstance> {
  const provider = opts.provider ?? createProvider();
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 64 * 1024 });

  // Keep the raw body: webhook signatures are computed over exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = body;
    if (body.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      done(new ApiError(400, 'invalid_json', 'Request body is not valid JSON'), undefined);
    }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body: string, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body))),
  );

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send(err.toBody());
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      return reply.code(400).send({
        error: { code: 'validation_error', message: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request' },
      });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 429) return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests, slow down' } });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: { code: 'bad_request', message: e.message } });
    req.log.error(err);
    if (!opts.logger) console.error(err);
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  await app.register(rateLimit, { global: false, allowList: () => opts.rateLimit === false });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
  });

  await app.register(fastifyStatic, { root: publicDir });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, provider: provider.name };
  });

  // ---- Auth ---------------------------------------------------------------

  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/auth/register', authLimit, async (req, reply) => {
    const body = schemas.register.parse(req.body);
    await createUser(body);
    const session = (await login(body.email, body.password))!;
    return reply.code(201).send({ token: session.token, user: describeUser(session.user) });
  });

  app.post('/api/auth/login', authLimit, async (req) => {
    const body = schemas.login.parse(req.body);
    const session = await login(body.email, body.password);
    if (!session) throw unauthorized('Incorrect email or password');
    return { token: session.token, user: describeUser(session.user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = tokenFrom(req);
    if (token) await logout(token);
    return reply.code(204).send();
  });

  // ---- Profile & wallet -----------------------------------------------------

  app.get('/api/me', async (req) => describeUser(await requireUser(req)));

  app.post('/api/me/verify-identity', authLimit, async (req) => {
    const user = await requireActiveUser(req);
    return verifyIdentity(user.id, schemas.kyc.parse(req.body).idNumber);
  });

  app.get('/api/wallet', async (req) => {
    const user = await requireUser(req);
    const balance = await getBalance(pool, await walletIdForUser(pool, user.id));
    return { balance: formatAmount(balance), currency: 'ZAR' };
  });

  app.get('/api/activity', async (req) => activity((await requireUser(req)).id));

  app.get('/api/users/lookup', async (req) => {
    await requireUser(req);
    const q = z.object({ q: z.string().min(1).max(254) }).parse(req.query);
    const u = await findRecipient(pool, q.q);
    return { id: u.id, handle: u.handle, displayName: u.displayName };
  });

  // ---- P2P transfers ------------------------------------------------------

  app.post('/api/transfers', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = await requireActiveUser(req);
    const key = idempotencyKey(req);
    const body = schemas.transfer.parse(req.body);
    const result = await runIdempotent(user.id, key, { op: 'transfer', ...body, amount: body.amount.toString() }, async (client) => {
      const recipient = await findRecipient(client, body.to);
      const transfer = await sendMoney(client, { senderId: user.id, recipientId: recipient.id, amount: body.amount, note: body.note });
      return { status: 201, body: transfer };
    });
    return send(reply, result);
  });

  // ---- Payment requests ---------------------------------------------------

  app.get('/api/requests', async (req) => listRequests((await requireUser(req)).id));

  app.post('/api/requests', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = await requireActiveUser(req);
    const body = schemas.request.parse(req.body);
    const payer = await findRecipient(pool, body.from);
    return reply.code(201).send(await createRequest({ requesterId: user.id, payerId: payer.id, amount: body.amount, note: body.note }));
  });

  app.post('/api/requests/:id/pay', async (req, reply) => {
    const user = await requireActiveUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const result = await runIdempotent(user.id, idempotencyKey(req), { op: 'pay_request', id }, async (client) => ({
      status: 200,
      body: await payRequest(client, user.id, id),
    }));
    return send(reply, result);
  });

  for (const action of ['decline', 'cancel'] as const) {
    app.post(`/api/requests/:id/${action}`, async (req) => {
      const user = await requireUser(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      return withTx((client) => closeRequest(client, user.id, id, action));
    });
  }

  // ---- Deposits (top-ups) -------------------------------------------------

  app.get('/api/deposits', async (req) => listDeposits((await requireUser(req)).id));

  app.post('/api/deposits', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = await requireActiveUser(req);
    const { amount } = schemas.deposit.parse(req.body);
    return reply.code(201).send(await createDeposit(provider, user, amount));
  });

  // ---- Bank accounts & withdrawals ----------------------------------------

  app.get('/api/banks', async (req) => {
    await requireUser(req);
    return provider.listBanks();
  });

  app.get('/api/bank-accounts', async (req) => listBankAccounts((await requireUser(req)).id));

  app.post('/api/bank-accounts', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = await requireActiveUser(req);
    return reply.code(201).send(await addBankAccount(provider, user, schemas.bankAccount.parse(req.body)));
  });

  app.get('/api/withdrawals', async (req) => listWithdrawals((await requireUser(req)).id));

  app.post('/api/withdrawals', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = await requireActiveUser(req);
    const body = schemas.withdrawal.parse(req.body);
    const result = await runIdempotent(
      user.id,
      idempotencyKey(req),
      { op: 'withdrawal', bankAccountId: body.bankAccountId, amount: body.amount.toString() },
      async (client) => ({ status: 201, body: await createWithdrawal(client, user, body) }),
    );
    const created = result.body as { id?: string };
    if (result.status === 201 && created.id) {
      // Submit to the provider after the funds are safely reserved (no-op on replay),
      // then report the current state, which may already be 'failed'.
      await dispatchWithdrawal(provider, created.id);
      return reply.code(201).send(await getWithdrawal(user.id, created.id));
    }
    return send(reply, result);
  });

  // ---- Provider webhooks --------------------------------------------------

  app.post('/webhooks/:provider', async (req, reply) => {
    const { provider: name } = req.params as { provider: string };
    if (name !== provider.name) return reply.code(404).send({ ok: false });
    if (!req.rawBody) return reply.code(400).send({ ok: false });
    return send(reply, await processWebhook(provider, req.rawBody, req.headers));
  });

  // ---- Sandbox-only fake checkout ------------------------------------------

  if (provider instanceof SandboxProvider) {
    provider.setDeliver((raw, headers) => processWebhook(provider, raw, headers));

    app.get('/sandbox/checkout/:ref', async (req, reply) => {
      const { ref } = req.params as { ref: string };
      const charge = provider.getCharge(ref);
      if (!charge) return reply.code(404).type('text/html').send('<p>Unknown or expired checkout.</p>');
      return reply.type('text/html').send(sandboxCheckoutPage(ref, formatAmount(charge.amount), charge.status));
    });

    app.post('/sandbox/checkout/:ref', async (req, reply) => {
      const { ref } = req.params as { ref: string };
      const { outcome } = z.object({ outcome: z.enum(['success', 'failed']) }).parse(req.body);
      await provider.completeCheckout(ref, outcome);
      return reply.redirect(`/?deposit=${encodeURIComponent(ref)}`, 303);
    });
  }

  // ---- Admin --------------------------------------------------------------

  app.get('/admin/reconciliation', async (req) => {
    const token = tokenFrom(req);
    const expected = config.ADMIN_TOKEN;
    if (!expected || !token || token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      throw forbidden('forbidden', 'Admin token required');
    }
    const r = await reconcile(pool);
    return {
      ok: r.ok,
      ledgerSum: formatAmount(r.ledgerSum),
      customerFunds: formatAmount(r.customerFunds),
      systemAccounts: Object.fromEntries(Object.entries(r.systemAccounts).map(([k, v]) => [k, formatAmount(v)])),
      balanceMismatches: r.mismatches,
      stuckWithdrawals: await stuckWithdrawals(),
      note: 'external_settlement should equal minus the cash held at the provider/bank (deposits in, payouts out).',
    };
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  });

  return app;
}

function sandboxCheckoutPage(ref: string, amount: string, status: string) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sandbox checkout</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f4f5;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#fff;border-radius:16px;padding:32px;max-width:360px;width:calc(100% - 32px);box-shadow:0 4px 24px #0001}
h1{font-size:18px;margin:0 0 4px}.amt{font-size:36px;font-weight:700;margin:16px 0}.muted{color:#71717a;font-size:13px}
button{width:100%;padding:14px;border:0;border-radius:10px;font-size:16px;cursor:pointer;margin-top:10px}
.pay{background:#16a34a;color:#fff}.fail{background:#e4e4e7}</style></head><body><div class="card">
<h1>Sandbox payment</h1><div class="muted">No real money moves. This page stands in for the provider's card / instant EFT checkout.</div>
<div class="amt">R ${esc(amount)}</div><div class="muted">Reference ${esc(ref)}</div>
${
  status === 'pending'
    ? `<form method="post"><input type="hidden" name="outcome" value="success"><button class="pay">Pay R ${esc(amount)}</button></form>
<form method="post"><input type="hidden" name="outcome" value="failed"><button class="fail">Simulate a declined payment</button></form>`
    : `<p>This checkout is already <b>${esc(status)}</b>.</p><a href="/">Back to wallet</a>`
}
</div></body></html>`;
}
