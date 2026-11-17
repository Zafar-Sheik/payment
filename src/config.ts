import 'dotenv/config';
import { z } from 'zod';

const env = z
  .object({
    DATABASE_URL: z.string().default('postgres://pay:pay@localhost:5432/payments'),
    PORT: z.coerce.number().int().default(3000),
    PUBLIC_URL: z.string().default('http://localhost:3000'),
    PAYMENT_PROVIDER: z.enum(['sandbox', 'paystack']).default('sandbox'),
    SANDBOX_WEBHOOK_SECRET: z.string().default('dev-sandbox-secret'),
    SANDBOX_PAYOUT_DELAY_MS: z.coerce.number().int().min(0).default(1500),
    PAYSTACK_SECRET_KEY: z.string().default(''),
    ADMIN_TOKEN: z.string().default(''),
    // Secret used to hash SA ID numbers (duplicate-identity detection without storing them).
    KYC_PEPPER: z.string().default('dev-kyc-pepper'),
    WITHDRAWAL_FEE_CENTS: z.coerce.number().int().min(0).default(500),
    NODE_ENV: z.string().default('development'),
  })
  .parse(process.env);

if (env.PAYMENT_PROVIDER === 'paystack' && !env.PAYSTACK_SECRET_KEY) {
  throw new Error('PAYSTACK_SECRET_KEY is required when PAYMENT_PROVIDER=paystack');
}

if (env.NODE_ENV === 'production') {
  if (env.PAYMENT_PROVIDER === 'sandbox') throw new Error('The sandbox provider cannot run with NODE_ENV=production');
  if (env.KYC_PEPPER.startsWith('dev-') || env.KYC_PEPPER.startsWith('change-me')) throw new Error('Set a real KYC_PEPPER in production');
  if (env.ADMIN_TOKEN.length < 32) throw new Error('Set an ADMIN_TOKEN of at least 32 characters in production');
}

/**
 * Per-KYC-tier limits, in cents. These are product risk limits, not legal
 * advice: confirm the real thresholds with your sponsor bank and compliance
 * officer (FICA / FIC Act obligations).
 */
export const tierLimits = {
  0: { maxBalance: 5_000_00n, dailySend: 1_000_00n, canWithdraw: false },
  1: { maxBalance: 50_000_00n, dailySend: 25_000_00n, canWithdraw: true },
  2: { maxBalance: 500_000_00n, dailySend: 100_000_00n, canWithdraw: true },
} as const;

export type KycTier = keyof typeof tierLimits;

export const config = {
  ...env,
  isProduction: env.NODE_ENV === 'production',
  withdrawalFee: BigInt(env.WITHDRAWAL_FEE_CENTS),
  /** Maximum outgoing transfers per user per rolling hour. */
  maxTransfersPerHour: 30,
  /** Maximum single transaction amount (any type), in cents. */
  maxSingleAmount: 100_000_00n,
  sessionTtlDays: 7,
  currency: 'ZAR' as const,
};
