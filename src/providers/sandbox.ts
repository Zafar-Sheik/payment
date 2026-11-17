import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { ProviderRejectedError, type Bank, type PaymentProvider, type WebhookEvent } from './types.js';

/**
 * A fake payment provider for development and tests. No real money moves.
 *
 * It behaves like a real one: hosted checkout page, signed webhooks delivered
 * asynchronously, payouts that settle later and can fail.
 *
 * Test bank account numbers:
 *   ...0000  -> payout rejected immediately by the "provider"
 *   ...9999  -> payout accepted, then fails asynchronously (bank rejected it)
 *   anything else -> payout succeeds after SANDBOX_PAYOUT_DELAY_MS
 */

// Universal branch codes of major South African banks.
const SA_BANKS: Bank[] = [
  { code: '632005', name: 'ABSA Bank' },
  { code: '430000', name: 'African Bank' },
  { code: '470010', name: 'Capitec Bank' },
  { code: '679000', name: 'Discovery Bank' },
  { code: '250655', name: 'First National Bank (FNB)' },
  { code: '580105', name: 'Investec' },
  { code: '198765', name: 'Nedbank' },
  { code: '051001', name: 'Standard Bank' },
  { code: '678910', name: 'TymeBank' },
];

type Deliver = (rawBody: Buffer, headers: Record<string, string>) => Promise<unknown>;

interface SandboxCharge {
  reference: string;
  amount: bigint;
  status: 'pending' | 'success' | 'failed';
}

export class SandboxProvider implements PaymentProvider {
  readonly name = 'sandbox';
  private charges = new Map<string, SandboxCharge>();
  private inflight = new Set<Promise<unknown>>();
  private deliver: Deliver | null = null;

  constructor(
    private readonly secret = config.SANDBOX_WEBHOOK_SECRET,
    private readonly payoutDelayMs = config.SANDBOX_PAYOUT_DELAY_MS,
  ) {}

  /** The app wires this up so "webhooks" are delivered to its webhook handler. */
  setDeliver(fn: Deliver) {
    this.deliver = fn;
  }

  async createCheckout(input: { reference: string; amount: bigint }) {
    this.charges.set(input.reference, { reference: input.reference, amount: input.amount, status: 'pending' });
    return { checkoutUrl: `/sandbox/checkout/${encodeURIComponent(input.reference)}` };
  }

  getCharge(reference: string) {
    return this.charges.get(reference);
  }

  /** Called by the fake checkout page when the user clicks Pay / Fail. */
  async completeCheckout(reference: string, outcome: 'success' | 'failed') {
    const charge = this.charges.get(reference);
    if (!charge || charge.status !== 'pending') return false;
    charge.status = outcome;
    await this.emit({
      event: outcome === 'success' ? 'charge.success' : 'charge.failed',
      data: { reference, amount: charge.amount.toString(), currency: 'ZAR', id: randomBytes(6).toString('hex') },
    });
    return true;
  }

  async verifyCharge(reference: string) {
    const c = this.charges.get(reference);
    if (!c) return { status: 'pending' as const, amount: 0n, currency: 'ZAR' };
    return { status: c.status, amount: c.amount, currency: 'ZAR' };
  }

  async listBanks() {
    return SA_BANKS;
  }

  async createRecipient(input: { name: string; accountNumber: string; bankCode: string }) {
    if (!SA_BANKS.some((b) => b.code === input.bankCode)) throw new ProviderRejectedError('Unknown bank');
    const suffix = input.accountNumber.endsWith('0000') ? 'REJECT' : input.accountNumber.endsWith('9999') ? 'FAIL' : 'OK';
    return { recipientCode: `RCP_sbx_${randomBytes(6).toString('hex')}_${suffix}` };
  }

  async initiatePayout(input: { reference: string; amount: bigint; recipientCode: string }) {
    if (input.recipientCode.endsWith('_REJECT')) throw new ProviderRejectedError('Recipient account rejected by bank');
    const fail = input.recipientCode.endsWith('_FAIL');
    this.track(
      new Promise((r) => setTimeout(r, this.payoutDelayMs)).then(() =>
        this.emit({
          event: fail ? 'transfer.failed' : 'transfer.success',
          data: {
            reference: input.reference,
            amount: input.amount.toString(),
            currency: 'ZAR',
            id: randomBytes(6).toString('hex'),
            reason: fail ? 'Account closed' : undefined,
          },
        }),
      ),
    );
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent | null {
    const sig = headers['x-sandbox-signature'];
    if (typeof sig !== 'string') return null;
    const expected = createHmac('sha512', this.secret).update(rawBody).digest('hex');
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

    const body = JSON.parse(rawBody.toString('utf8'));
    const d = body.data ?? {};
    const dedupeKey = `${body.event}:${d.reference}:${d.id}`;
    const base = { reference: String(d.reference), amount: BigInt(d.amount), currency: String(d.currency), dedupeKey, reason: d.reason };
    switch (body.event) {
      case 'charge.success':
      case 'charge.failed':
        return { type: body.event, ...base };
      case 'transfer.success':
        return { type: 'payout.success', ...base };
      case 'transfer.failed':
        return { type: 'payout.failed', ...base };
      default:
        return { type: 'ignored', dedupeKey, raw: String(body.event) };
    }
  }

  /** Wait until all scheduled webhook deliveries have completed (for tests). */
  async flush() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private async emit(payload: unknown) {
    if (!this.deliver) throw new Error('Sandbox provider has no webhook receiver');
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha512', this.secret).update(raw).digest('hex');
    await this.deliver(raw, { 'x-sandbox-signature': signature, 'content-type': 'application/json' });
  }

  private track(p: Promise<unknown>) {
    const tracked = p.catch((err) => console.error('[sandbox] webhook delivery failed', err)).finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }
}
