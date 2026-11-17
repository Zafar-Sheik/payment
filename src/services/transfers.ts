import type { PoolClient } from 'pg';
import { one } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { lockAccounts, postTransaction, walletIdForUser } from '../ledger.js';
import { formatAmount } from '../money.js';
import type { KycTier } from '../config.js';
import { assertCanHold, assertCanSend } from './limits.js';

interface Party {
  id: string;
  handle: string;
  display_name: string;
  kyc_tier: KycTier;
  status: string;
}

/**
 * Move money from one user's wallet to another's. Runs inside the caller's
 * transaction (so it can be combined with idempotency / payment requests).
 */
export async function sendMoney(
  client: PoolClient,
  input: { senderId: string; recipientId: string; amount: bigint; note?: string | null; paymentRequestId?: string },
) {
  if (input.senderId === input.recipientId) throw badRequest('self_transfer', 'You cannot send money to yourself');

  const parties = await client.query<Party>('SELECT id, handle, display_name, kyc_tier, status FROM users WHERE id = ANY($1::uuid[])', [
    [input.senderId, input.recipientId],
  ]);
  const sender = parties.rows.find((u) => u.id === input.senderId);
  const recipient = parties.rows.find((u) => u.id === input.recipientId);
  if (!sender) throw notFound('Sender not found');
  if (!recipient) throw notFound('Recipient not found');
  if (sender.status !== 'active') throw forbidden('account_frozen', 'Your account is frozen');
  if (recipient.status !== 'active') throw forbidden('recipient_unavailable', 'This recipient cannot receive payments');

  const senderWallet = await walletIdForUser(client, sender.id);
  const recipientWallet = await walletIdForUser(client, recipient.id);
  const locked = await lockAccounts(client, [senderWallet, recipientWallet]);

  await assertCanSend(client, senderWallet, sender.kyc_tier, input.amount);
  assertCanHold(recipient.kyc_tier, locked.get(recipientWallet)!.balance, input.amount, 'recipient');

  const note = input.note?.trim() || null;
  const transactionId = await postTransaction(client, {
    kind: 'transfer',
    description: `Payment from @${sender.handle} to @${recipient.handle}`,
    metadata: {
      senderId: sender.id,
      senderHandle: sender.handle,
      recipientId: recipient.id,
      recipientHandle: recipient.handle,
      note,
      paymentRequestId: input.paymentRequestId,
    },
    entries: [
      { accountId: senderWallet, amount: -input.amount },
      { accountId: recipientWallet, amount: input.amount },
    ],
  });

  const transfer = (await one<{ id: string; created_at: string }>(
    client,
    `INSERT INTO transfers (sender_id, recipient_id, amount, note, transaction_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [sender.id, recipient.id, input.amount.toString(), note, transactionId],
  ))!;

  return {
    id: transfer.id,
    transactionId,
    amount: formatAmount(input.amount),
    currency: 'ZAR',
    note,
    from: { id: sender.id, handle: sender.handle, displayName: sender.display_name },
    to: { id: recipient.id, handle: recipient.handle, displayName: recipient.display_name },
    createdAt: transfer.created_at,
  };
}
