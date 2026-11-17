# Rand Wallet

A peer-to-peer payments app for South Africa: users top up a ZAR wallet, send money to each other instantly by `@handle` or email, request money, and withdraw to any South African bank account.

It runs fully in **sandbox mode** (no real money) out of the box, and has a **Paystack** adapter for real card / instant-EFT top-ups and bank payouts once you have a licensed setup (see [Going live](#going-live-in-south-africa)).

## Quick start

With Docker:

```bash
docker compose up --build
```

Then open http://localhost:3000.

Without Docker (needs Node 20+ and PostgreSQL 14+):

```bash
cp .env.example .env        # point DATABASE_URL at your Postgres
npm install
npm run dev                 # runs migrations, then serves on :3000
```

### Try it

1. Create two accounts (use two browsers, or a private window).
2. **Add money**. The sandbox checkout page stands in for the card/EFT page; click *Pay*.
3. **Send** money to the other user's `@handle`, or **Request** money from them.
4. **Verify** with a valid SA ID number (e.g. `8001015009087`) to unlock withdrawals.
5. **Withdraw** to a bank account. Sandbox test account numbers:
   - ending `0000`: the provider rejects it immediately
   - ending `9999`: accepted, then bounced by the bank (funds and fee are returned)
   - anything else: succeeds

Ledger health check: `curl -H "Authorization: Bearer $ADMIN_TOKEN" localhost:3000/admin/reconciliation`

### Tests

```bash
npm test     # needs Postgres; uses TEST_DATABASE_URL (default postgres://pay:pay@localhost:5432/payments_test)
```

35 tests run against a real Postgres database. They cover concurrent overspend attempts, concurrent duplicate requests, idempotent retries, webhook signature and replay handling, payout failures and reversals, KYC rules, and an end-of-run check that the books balance.

## How it works

**Stack:** TypeScript, Node, Fastify, PostgreSQL, Zod; plain HTML/JS front end with no build step.

```
browser ──► Fastify API ──► services (transfers, requests, deposits, withdrawals)
                                  │
                                  ▼
                        ledger.postTransaction()  ◄── the ONLY code that changes balances
                                  │
                                  ▼
                            PostgreSQL (double-entry, append-only)

payment provider (Sandbox | Paystack) ◄──► deposits / withdrawals
             └── signed webhooks ──► /webhooks/:provider
```

### Correctness guarantees

| Risk | How it is handled |
|---|---|
| Floating-point errors | All money is `BIGINT` cents; the API takes and returns decimal strings (`"120.50"`). |
| Money created or destroyed | Double-entry ledger. Every transaction's entries must sum to zero, checked in code **and** by a deferred Postgres constraint trigger at commit. |
| History tampering | `ledger_entries` / `ledger_transactions` are append-only (triggers reject UPDATE/DELETE). Corrections are new reversing transactions. |
| Overdraft under concurrency | Accounts are locked `FOR UPDATE` in a fixed order (no deadlocks); a `CHECK (balance >= 0)` constraint is the backstop. |
| Double charge on retry / double-click | Every money-moving POST needs an `Idempotency-Key`. The key is stored in the same DB transaction as the effect, so a retry replays the original response. |
| Forged or replayed webhooks | HMAC-SHA512 signature check on the raw body; events are de-duplicated; deposit amounts are re-verified with the provider API, never trusted from the webhook body. |
| Double payout | Withdrawals are claimed atomically (`pending → processing`) before being sent to the provider. Ambiguous provider errors are **never** treated as failures; they wait for reconciliation instead of being retried blindly. |
| Drift between cached balances and the ledger | `/admin/reconciliation` recomputes every balance from its entries. |

### Ledger accounts

- **User wallets** can never go negative.
- **`external_settlement`** mirrors cash held at the bank/provider. Its balance is negative: minus (customer funds + payouts in flight + fees earned). Reconcile this daily against your actual settlement account.
- **`withdrawals_pending`** holds money in flight to users' bank accounts.
- **`fee_revenue`** holds withdrawal fees (R5 default; P2P transfers are free).

### Money flows

| Event | Entries |
|---|---|
| Top-up confirmed | external_settlement −X, wallet +X |
| P2P transfer | sender −X, recipient +X |
| Withdrawal requested | wallet −(X+fee), withdrawals_pending +X, fee_revenue +fee |
| Payout confirmed | withdrawals_pending −X, external_settlement +X |
| Payout failed | withdrawals_pending −X, fee_revenue −fee, wallet +(X+fee) |

### Risk limits (`src/config.ts`)

| Tier | How reached | Max balance | Daily outflow | Withdraw |
|---|---|---|---|---|
| 0 | Email sign-up | R5,000 | R1,000 | No |
| 1 | SA ID verified | R50,000 | R25,000 | Yes |
| 2 | Full verification (not built yet) | R500,000 | R100,000 | Yes |

There is also a velocity limit of 30 transfers per hour, a R100,000 single-transaction cap, and rate limits on auth and money endpoints. These numbers are placeholders: set the real ones with your sponsor bank and compliance officer.

## API

All endpoints take and return JSON. Authenticated endpoints need `Authorization: Bearer <token>`.

| Method & path | Notes |
|---|---|
| `POST /api/auth/register` | `{ email, handle, displayName, password }` → `{ token, user }` |
| `POST /api/auth/login` / `logout` | |
| `GET /api/me` · `POST /api/me/verify-identity` | `{ idNumber }` |
| `GET /api/wallet` · `GET /api/activity` | |
| `GET /api/users/lookup?q=@handle` | |
| `POST /api/transfers` | `{ to, amount, note? }`, needs **Idempotency-Key** |
| `GET/POST /api/requests` | `{ from, amount, note? }` |
| `POST /api/requests/:id/pay` | needs **Idempotency-Key** |
| `POST /api/requests/:id/decline` · `/cancel` | |
| `GET/POST /api/deposits` | `{ amount }` → `{ checkoutUrl }` |
| `GET /api/banks` · `GET/POST /api/bank-accounts` | `{ bankCode, accountNumber, accountHolder }` |
| `GET/POST /api/withdrawals` | `{ bankAccountId, amount }`, needs **Idempotency-Key** |
| `POST /webhooks/:provider` | provider callbacks (signature-verified) |
| `GET /admin/reconciliation` | needs `ADMIN_TOKEN` |

## Going live in South Africa

The code is built to be correct with real money, but **you cannot legally operate this as a stored-value wallet on your own.** In South Africa, taking deposits and holding customer funds is reserved for banks (Banks Act), and payments activity is regulated by the SARB National Payment System Department, with FICA/AML obligations enforced by the FIC.

The realistic route:

1. **Partner with a sponsor bank or licensed e-money issuer.** In SA, e-money must be issued by or under a bank. The customer funds sit in a bank-held account, and you operate as the bank's technology/agent partner. Get a fintech lawyer involved early, and talk to the SARB Intergovernmental Fintech Working Group / Innovation Hub regulatory sandbox.
2. **Register as an accountable institution with the FIC** if your structure requires it, and appoint a compliance officer. You'll need a Risk Management and Compliance Programme (RMCP).
3. **Replace the KYC stub.** `verifyIdentity` only checks the ID number's format, checksum and age. Use a vendor (e.g. Smile ID, VerifyNow, Onfido) for Home Affairs verification, a liveness selfie, and sanctions/PEP screening.
4. **Add transaction monitoring and reporting**: suspicious and unusual transaction reports (STRs), cash threshold reports where applicable, and screening against the targeted financial sanctions list.
5. **Switch the provider:** set `PAYMENT_PROVIDER=paystack` and `PAYSTACK_SECRET_KEY`, point Paystack's webhook URL at `https://<your-domain>/webhooks/paystack`, and confirm payouts ("transfers") are enabled for your SA account. Check the adapter's field names against Paystack's current API docs. Ozow or Stitch could be added as further adapters behind the same `PaymentProvider` interface.
6. **Comply with POPIA** (data protection). Bank account numbers are already kept only at the provider, and ID numbers are stored only as a keyed hash.
7. **Run operations**: daily reconciliation of `external_settlement` against bank statements, a runbook for withdrawals stuck in `processing`, a support/disputes process, and an external security review and penetration test.

### Not built yet (sensible next steps)

- Phone-number sign-up with SMS OTP, and 2FA / step-up auth for large payments
- Email/push notifications for received payments and requests
- Tier 2 (enhanced due diligence) verification flow
- Admin console: freeze accounts, review flagged deposits, resolve stuck payouts
- Scheduled job to poll the provider for withdrawals stuck in `processing`
- Pay-by-QR / payment links for merchants
