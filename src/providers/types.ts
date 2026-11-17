/**
 * The boundary between our ledger and the regulated institution that actually
 * holds and moves rands. Swap implementations without touching the ledger.
 */

export interface Bank {
  code: string;
  name: string;
}

export type WebhookEvent =
  | { type: 'charge.success' | 'charge.failed'; reference: string; amount: bigint; currency: string; dedupeKey: string; reason?: string }
  | { type: 'payout.success' | 'payout.failed'; reference: string; amount: bigint; currency: string; dedupeKey: string; reason?: string }
  | { type: 'ignored'; dedupeKey: string; raw: string };

export interface PaymentProvider {
  readonly name: string;

  /** Start a hosted checkout (card / instant EFT) for a wallet top-up. */
  createCheckout(input: { reference: string; amount: bigint; email: string; callbackUrl: string }): Promise<{ checkoutUrl: string }>;

  /** Ask the provider directly for the state of a charge (never trust a webhook body alone). */
  verifyCharge(reference: string): Promise<{ status: 'success' | 'failed' | 'pending'; amount: bigint; currency: string }>;

  listBanks(): Promise<Bank[]>;

  /** Register a payout destination. The provider keeps the full account number. */
  createRecipient(input: { name: string; accountNumber: string; bankCode: string }): Promise<{ recipientCode: string }>;

  /**
   * Send money to a recipient's bank account. Throws ProviderRejectedError
   * when the provider definitively refused the payout; any other error means
   * the outcome is unknown and the payout must not be assumed failed.
   */
  initiatePayout(input: { reference: string; amount: bigint; recipientCode: string; reason: string }): Promise<void>;

  /** Verify the signature of a webhook and normalise it. Returns null if the signature is invalid. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent | null;
}

export class ProviderRejectedError extends Error {}
