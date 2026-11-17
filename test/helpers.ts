import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { SandboxProvider } from '../src/providers/sandbox.js';

export async function setupApp() {
  const provider = new SandboxProvider('test-sandbox-secret', 0);
  const app = await buildApp({ provider, rateLimit: false });
  return { app, provider };
}

let counter = 0;

export interface TestUser {
  token: string;
  id: string;
  handle: string;
  email: string;
}

export async function register(app: FastifyInstance, name?: string): Promise<TestUser> {
  const handle = (name ?? 'user') + '_' + (Date.now() % 1e6).toString(36) + (counter++).toString(36);
  const email = `${handle}@example.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, handle, displayName: handle, password: 'a-long-password' },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const body = res.json();
  return { token: body.token, id: body.user.id, handle, email };
}

export function call(app: FastifyInstance, user: TestUser | null, method: 'GET' | 'POST', url: string, payload?: unknown, idemKey?: string) {
  const headers: Record<string, string> = {};
  if (user) headers.authorization = `Bearer ${user.token}`;
  if (idemKey) headers['idempotency-key'] = idemKey;
  return app.inject({ method, url, payload: payload as object | undefined, headers });
}

export const key = () => randomUUID();

export async function balance(app: FastifyInstance, user: TestUser): Promise<string> {
  return (await call(app, user, 'GET', '/api/wallet')).json().balance;
}

/** Top up a wallet through the full sandbox checkout + signed webhook path. */
export async function deposit(app: FastifyInstance, provider: SandboxProvider, user: TestUser, amount: string) {
  const res = await call(app, user, 'POST', '/api/deposits', { amount });
  if (res.statusCode !== 201) throw new Error(`deposit failed: ${res.body}`);
  const { reference } = res.json();
  await provider.completeCheckout(reference, 'success');
  return reference as string;
}

/** A structurally valid SA ID number for someone born in 1980. */
export function validSaId(seq = 0): string {
  const base = `800101${String(1000 + (seq % 3999)).padStart(4, "0")}08`;
  for (let check = 0; check <= 9; check++) {
    const id = base + check;
    let sum = 0;
    for (let i = 0; i < 13; i++) {
      let d = Number(id[12 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return id;
  }
  throw new Error('unreachable');
}

let idSeq = 0;
export async function verify(app: FastifyInstance, user: TestUser) {
  const res = await call(app, user, 'POST', '/api/me/verify-identity', { idNumber: validSaId(++idSeq) });
  if (res.statusCode !== 200) throw new Error(`verify failed: ${res.body}`);
}
