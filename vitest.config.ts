import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://pay:pay@localhost:5432/payments_test',
      ADMIN_TOKEN: 'test-admin-token',
      PAYMENT_PROVIDER: 'sandbox',
      SANDBOX_PAYOUT_DELAY_MS: '0',
    },
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
