import { z } from 'zod';
import { config } from './config.js';

/**
 * Money is represented as bigint cents internally and as decimal strings
 * ("125.50") on the API. Floats never touch an amount.
 */

const AMOUNT_RE = /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/;

export function parseAmount(input: string): bigint {
  const s = input.trim();
  if (!AMOUNT_RE.test(s)) throw new Error('Invalid amount');
  const [rands, cents = ''] = s.split('.');
  return BigInt(rands!) * 100n + BigInt(cents.padEnd(2, '0') || '0');
}

export function formatAmount(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const r = abs / 100n;
  const c = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${r}.${c}`;
}

/** Zod schema for a positive API amount, e.g. "10" or "10.50" (also accepts numbers). */
export const amountSchema = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    try {
      const cents = parseAmount(String(v));
      if (cents <= 0n) throw new Error();
      if (cents > config.maxSingleAmount) {
        ctx.addIssue({ code: 'custom', message: `Amount exceeds maximum of R${formatAmount(config.maxSingleAmount)}` });
        return z.NEVER;
      }
      return cents;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Amount must be a positive value in rands with at most 2 decimals' });
      return z.NEVER;
    }
  });

export const toBig = (v: string | number | bigint): bigint => BigInt(v);
