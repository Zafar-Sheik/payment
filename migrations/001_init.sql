-- Core schema for the P2P wallet.
--
-- Money is always stored as BIGINT minor units (cents). Never floats.
--
-- Ledger sign convention: every ledger transaction is a set of entries whose
-- amounts sum to exactly zero. A positive amount increases an account's
-- balance, a negative amount decreases it. User wallets may never go below
-- zero. The `external_settlement` system account is the mirror image of all
-- money that has entered the system from the outside world, so its balance is
-- negative and equals (minus) the funds we should be holding at the bank /
-- payment provider.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  handle         TEXT NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9_]{3,20}$'),
  display_name   TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  password_hash  TEXT NOT NULL,
  -- 0 = email only, 1 = identity verified (FICA-lite), 2 = fully verified
  kyc_tier       SMALLINT NOT NULL DEFAULT 0 CHECK (kyc_tier BETWEEN 0 AND 2),
  id_number_hash TEXT UNIQUE,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash  BYTEA PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL CHECK (kind IN ('user_wallet', 'system')),
  user_id         UUID REFERENCES users(id),
  code            TEXT UNIQUE,
  currency        CHAR(3) NOT NULL DEFAULT 'ZAR',
  balance         BIGINT NOT NULL DEFAULT 0,
  allow_negative  BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (allow_negative OR balance >= 0),
  CHECK ((kind = 'user_wallet' AND user_id IS NOT NULL AND code IS NULL)
      OR (kind = 'system' AND user_id IS NULL AND code IS NOT NULL))
);
CREATE UNIQUE INDEX accounts_user_currency_idx ON accounts(user_id, currency) WHERE kind = 'user_wallet';

INSERT INTO accounts (kind, code, allow_negative) VALUES
  ('system', 'external_settlement', true),  -- mirror of money held at the bank/provider
  ('system', 'withdrawals_pending', false), -- funds in flight to a user's bank account
  ('system', 'fee_revenue', false);         -- fees we have earned

CREATE TABLE ledger_transactions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL CHECK (kind IN ('transfer', 'deposit', 'withdrawal', 'withdrawal_settled', 'withdrawal_reversal')),
  description  TEXT NOT NULL,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID NOT NULL REFERENCES ledger_transactions(id),
  account_id      UUID NOT NULL REFERENCES accounts(id),
  amount          BIGINT NOT NULL CHECK (amount <> 0),
  balance_after   BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries(account_id, id DESC);
CREATE INDEX ledger_entries_txn_idx ON ledger_entries(transaction_id);

-- Database-level guarantee that every ledger transaction balances. Deferred so
-- that all entries of a transaction can be inserted before the check runs at
-- COMMIT.
CREATE FUNCTION assert_transaction_balanced() RETURNS trigger AS $$
DECLARE
  total NUMERIC;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO total FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % does not balance (sum=%)', NEW.transaction_id, total;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced();

-- The ledger is append-only.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE idempotency_keys (
  user_id          UUID NOT NULL REFERENCES users(id),
  key              TEXT NOT NULL CHECK (length(key) BETWEEN 8 AND 100),
  request_hash     TEXT NOT NULL,
  response_status  INT NOT NULL,
  response_body    JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE transfers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id       UUID NOT NULL REFERENCES users(id),
  recipient_id    UUID NOT NULL REFERENCES users(id),
  amount          BIGINT NOT NULL CHECK (amount > 0),
  note            TEXT,
  transaction_id  UUID NOT NULL UNIQUE REFERENCES ledger_transactions(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX transfers_sender_idx ON transfers(sender_id, created_at DESC);

CREATE TABLE payment_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id  UUID NOT NULL REFERENCES users(id),
  payer_id      UUID NOT NULL REFERENCES users(id),
  amount        BIGINT NOT NULL CHECK (amount > 0),
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'declined', 'cancelled')),
  transfer_id   UUID REFERENCES transfers(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (requester_id <> payer_id)
);
CREATE INDEX payment_requests_payer_idx ON payment_requests(payer_id, status);
CREATE INDEX payment_requests_requester_idx ON payment_requests(requester_id, status);

CREATE TABLE deposits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  amount          BIGINT NOT NULL CHECK (amount > 0),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  provider        TEXT NOT NULL,
  reference       TEXT NOT NULL UNIQUE,
  checkout_url    TEXT,
  transaction_id  UUID REFERENCES ledger_transactions(id),
  failure_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deposits_user_idx ON deposits(user_id, created_at DESC);

CREATE TABLE bank_accounts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id),
  bank_code        TEXT NOT NULL,
  bank_name        TEXT NOT NULL,
  account_holder   TEXT NOT NULL,
  -- We never store the full account number; the provider holds it behind a
  -- recipient code.
  account_last4    TEXT NOT NULL,
  provider         TEXT NOT NULL,
  recipient_code   TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bank_accounts_user_idx ON bank_accounts(user_id);

CREATE TABLE withdrawals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id),
  bank_account_id    UUID NOT NULL REFERENCES bank_accounts(id),
  amount             BIGINT NOT NULL CHECK (amount > 0),
  fee                BIGINT NOT NULL CHECK (fee >= 0),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
  provider           TEXT NOT NULL,
  reference          TEXT NOT NULL UNIQUE,
  hold_transaction_id    UUID NOT NULL REFERENCES ledger_transactions(id),
  final_transaction_id   UUID REFERENCES ledger_transactions(id),
  failure_reason     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX withdrawals_user_idx ON withdrawals(user_id, created_at DESC);
CREATE INDEX withdrawals_status_idx ON withdrawals(status) WHERE status IN ('pending', 'processing');

CREATE TABLE webhook_events (
  id            BIGSERIAL PRIMARY KEY,
  provider      TEXT NOT NULL,
  dedupe_key    TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  UNIQUE (provider, dedupe_key)
);
