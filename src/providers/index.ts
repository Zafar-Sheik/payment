import { config } from '../config.js';
import { PaystackProvider } from './paystack.js';
import { SandboxProvider } from './sandbox.js';
import type { PaymentProvider } from './types.js';

export function createProvider(): PaymentProvider {
  return config.PAYMENT_PROVIDER === 'paystack' ? new PaystackProvider(config.PAYSTACK_SECRET_KEY) : new SandboxProvider();
}

export { SandboxProvider, PaystackProvider };
export type { PaymentProvider };
