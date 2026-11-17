import { pool, one } from '../db.js';
import type { PaymentProvider } from '../providers/types.js';
import { failDeposit, settleDeposit } from './deposits.js';
import { reverseWithdrawal, settleWithdrawal } from './withdrawals.js';

export type WebhookResult = { status: 200 | 401; body: { ok: boolean; detail?: string } };

/**
 * Verify, de-duplicate and apply a provider webhook. Every handler is
 * idempotent, so redelivery (which providers do routinely) is safe. Throwing
 * makes the route return 500, which tells the provider to retry later.
 */
export async function processWebhook(
  provider: PaymentProvider,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
): Promise<WebhookResult> {
  const event = provider.parseWebhook(rawBody, headers);
  if (!event) return { status: 401, body: { ok: false, detail: 'invalid signature' } };

  const inserted = await one<{ id: string }>(
    pool,
    `INSERT INTO webhook_events (provider, dedupe_key, event_type, payload) VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, dedupe_key) DO NOTHING RETURNING id`,
    [provider.name, event.dedupeKey, event.type, rawBody.toString('utf8')],
  );
  if (!inserted) {
    const prior = await one<{ processed_at: string | null }>(pool, 'SELECT processed_at FROM webhook_events WHERE provider = $1 AND dedupe_key = $2', [
      provider.name,
      event.dedupeKey,
    ]);
    if (prior?.processed_at) return { status: 200, body: { ok: true, detail: 'duplicate' } };
  }

  let detail: string;
  switch (event.type) {
    case 'charge.success': {
      // Don't trust the webhook body for the amount — ask the provider.
      const verified = await provider.verifyCharge(event.reference);
      if (verified.status === 'success') detail = (await settleDeposit(event.reference, verified)).outcome;
      else if (verified.status === 'failed') {
        await failDeposit(event.reference, 'Payment failed');
        detail = 'failed';
      } else throw new Error(`Charge ${event.reference} not yet confirmed by provider`);
      break;
    }
    case 'charge.failed':
      await failDeposit(event.reference, event.reason ?? 'Payment failed');
      detail = 'failed';
      break;
    case 'payout.success':
      detail = (await settleWithdrawal(event.reference)) ? 'settled' : 'already_processed';
      break;
    case 'payout.failed':
      detail = (await reverseWithdrawal(event.reference, event.reason ?? 'Payout failed')) ? 'reversed' : 'already_processed';
      break;
    case 'ignored':
      detail = `ignored ${event.raw}`;
      break;
  }

  await pool.query('UPDATE webhook_events SET processed_at = now() WHERE provider = $1 AND dedupe_key = $2', [provider.name, event.dedupeKey]);
  return { status: 200, body: { ok: true, detail } };
}
