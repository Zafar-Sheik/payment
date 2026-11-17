import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderRejectedError, type Bank, type PaymentProvider, type WebhookEvent } from './types.js';

/**
 * Paystack adapter (operates in South Africa, settles in ZAR).
 *
 * Docs: https://paystack.com/docs/api/
 *  - Amounts are in the currency's subunit (cents for ZAR).
 *  - Webhooks are signed with HMAC-SHA512 of the raw body using the secret key
 *    (header `x-paystack-signature`).
 *  - Payouts ("transfers") must be enabled on your Paystack account, and SA
 *    recipients use type "basa".
 *
 * Verify field names against the current Paystack docs before going live.
 */
export class PaystackProvider implements PaymentProvider {
  readonly name = 'paystack';
  private readonly base = 'https://api.paystack.co';

  constructor(private readonly secretKey: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new Error(`Paystack ${method} ${path} failed: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
    if (res.status >= 400 && res.status < 500) {
      throw new ProviderRejectedError(json.message ?? `Paystack rejected request (${res.status})`);
    }
    if (!res.ok || !json.status) throw new Error(`Paystack ${method} ${path} error ${res.status}: ${json.message ?? ''}`);
    return json.data as T;
  }

  async createCheckout(input: { reference: string; amount: bigint; email: string; callbackUrl: string }) {
    const data = await this.call<{ authorization_url: string }>('POST', '/transaction/initialize', {
      email: input.email,
      amount: input.amount.toString(),
      currency: 'ZAR',
      reference: input.reference,
      callback_url: input.callbackUrl,
    });
    return { checkoutUrl: data.authorization_url };
  }

  async verifyCharge(reference: string) {
    const data = await this.call<{ status: string; amount: number; currency: string }>(
      'GET',
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
    const status = data.status === 'success' ? 'success' : ['failed', 'abandoned', 'reversed'].includes(data.status) ? 'failed' : 'pending';
    return { status, amount: BigInt(data.amount), currency: data.currency } as const;
  }

  async listBanks(): Promise<Bank[]> {
    const data = await this.call<{ name: string; code: string; active: boolean }[]>('GET', '/bank?country=south%20africa&currency=ZAR');
    return data.filter((b) => b.active !== false).map((b) => ({ code: b.code, name: b.name }));
  }

  async createRecipient(input: { name: string; accountNumber: string; bankCode: string }) {
    const data = await this.call<{ recipient_code: string }>('POST', '/transferrecipient', {
      type: 'basa',
      name: input.name,
      account_number: input.accountNumber,
      bank_code: input.bankCode,
      currency: 'ZAR',
    });
    return { recipientCode: data.recipient_code };
  }

  async initiatePayout(input: { reference: string; amount: bigint; recipientCode: string; reason: string }) {
    await this.call('POST', '/transfer', {
      source: 'balance',
      amount: input.amount.toString(),
      recipient: input.recipientCode,
      reference: input.reference,
      reason: input.reason,
      currency: 'ZAR',
    });
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent | null {
    const sig = headers['x-paystack-signature'];
    if (typeof sig !== 'string') return null;
    const expected = createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

    const body = JSON.parse(rawBody.toString('utf8'));
    const d = body.data ?? {};
    const dedupeKey = `${body.event}:${d.reference}:${d.id ?? ''}`;
    const base = {
      reference: String(d.reference),
      amount: BigInt(d.amount ?? 0),
      currency: String(d.currency ?? ''),
      dedupeKey,
      reason: d.gateway_response ?? d.reason,
    };
    switch (body.event) {
      case 'charge.success':
        return { type: 'charge.success', ...base };
      case 'transfer.success':
        return { type: 'payout.success', ...base };
      case 'transfer.failed':
      case 'transfer.reversed':
        return { type: 'payout.failed', ...base };
      default:
        return { type: 'ignored', dedupeKey, raw: String(body.event) };
    }
  }
}
