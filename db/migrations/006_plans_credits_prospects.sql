-- 006: paid plans, provider-agnostic billing events, credit ledger, prospects and batch audits.
-- Idempotent and additive: existing users, audits and usage records are preserved.
-- All new tables are server-only (the app's table-owner connection); RLS is enabled
-- and the Supabase API roles get no privileges, so nothing is exposed via the Data API.

-- ── 1. Plans (the application catalog in src/lib/billing/plans.ts is authoritative for limits) ──
INSERT INTO plans (id, name, description, sort_order) VALUES
  ('free', 'Free', 'Free plan: monthly credit allowance, up to 25 pages per audit.', 0),
  ('pro', 'Pro', 'Pro plan ($10/month): larger credit allowance, up to 150 pages per audit, PDF reports and AI explanations.', 1),
  ('business', 'Business', 'Business plan ($15/month): largest allowance, up to 500 pages per audit, prospect list and batch audits.', 2)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, sort_order = EXCLUDED.sort_order;

-- ── 2. Subscriptions: fields needed for verified provider events ──
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
-- Timestamp of the newest applied provider event: older (out-of-order) events never overwrite newer state.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_ref_idx ON subscriptions (provider, provider_reference) WHERE provider_reference IS NOT NULL;

-- Every verified billing event (provider webhook or audited manual operator action), recorded once.
CREATE TABLE IF NOT EXISTS billing_events (
  id               UUID PRIMARY KEY,
  provider         TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  event_id         TEXT NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 200),
  event_type       TEXT NOT NULL,
  user_id          UUID REFERENCES profiles (id) ON DELETE SET NULL,
  subscription_id  UUID REFERENCES subscriptions (id) ON DELETE SET NULL,
  occurred_at      TIMESTAMPTZ,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome          TEXT NOT NULL,
  detail           JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (provider, event_id)
);

-- ── 3. Credits ──
CREATE TABLE IF NOT EXISTS credit_accounts (
  principal_id  TEXT PRIMARY KEY REFERENCES principals (id) ON DELETE CASCADE,
  plan_id       TEXT NOT NULL,
  balance       INTEGER NOT NULL CHECK (balance >= 0),
  allowance     INTEGER NOT NULL CHECK (allowance >= 0),
  period_key    TEXT NOT NULL,
  period_start  TIMESTAMPTZ NOT NULL,
  period_end    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only, auditable record of every credit movement.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  principal_id     TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  delta            INTEGER NOT NULL,
  balance_after    INTEGER NOT NULL CHECK (balance_after >= 0),
  entry_type       TEXT NOT NULL CHECK (entry_type IN ('grant','expire','reserve','release','charge','refund','adjust')),
  operation        TEXT NOT NULL CHECK (char_length(operation) <= 60),
  audit_id         TEXT, -- no foreign key: the ledger outlives deleted audits
  period_key       TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL CHECK (char_length(idempotency_key) <= 200),
  detail           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS credit_ledger_principal_idx ON credit_ledger (principal_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS credit_ledger_reserve_idx ON credit_ledger (audit_id) WHERE entry_type = 'reserve';

-- ── 4. Prospects (lead-generation workflow; contact fields are entered by the user only) ──
CREATE TABLE IF NOT EXISTS prospects (
  id             UUID PRIMARY KEY,
  principal_id   TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  hostname       TEXT NOT NULL CHECK (char_length(hostname) BETWEEN 1 AND 253),
  website_url    TEXT NOT NULL CHECK (char_length(website_url) <= 2048),
  audit_id       TEXT REFERENCES audits (id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewing','contacted','converted')),
  notes          TEXT CHECK (notes IS NULL OR char_length(notes) <= 4000),
  contact_name   TEXT CHECK (contact_name IS NULL OR char_length(contact_name) <= 120),
  contact_email  TEXT CHECK (contact_email IS NULL OR char_length(contact_email) <= 254),
  contact_url    TEXT CHECK (contact_url IS NULL OR char_length(contact_url) <= 2048),
  evidence       JSONB,
  audited_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (principal_id, hostname)
);
CREATE INDEX IF NOT EXISTS prospects_principal_updated_idx ON prospects (principal_id, updated_at DESC);

-- ── 5. Batch audits (queued, executed within the plan's concurrency limit) ──
CREATE TABLE IF NOT EXISTS audit_batches (
  id            UUID PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  ip_hash       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_batch_items (
  id            UUID PRIMARY KEY,
  batch_id      UUID NOT NULL REFERENCES audit_batches (id) ON DELETE CASCADE,
  principal_id  TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  url           TEXT NOT NULL CHECK (char_length(url) <= 2048),
  max_pages     INTEGER NOT NULL CHECK (max_pages > 0),
  status        TEXT NOT NULL CHECK (status IN ('pending','started','skipped','failed')),
  audit_id      TEXT REFERENCES audits (id) ON DELETE SET NULL,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_batch_items_pending_idx ON audit_batch_items (principal_id, created_at, position) WHERE status = 'pending';

-- ── 6. Read-only report share links (only the SHA-256 of the token is stored) ──
CREATE TABLE IF NOT EXISTS report_shares (
  id              UUID PRIMARY KEY,
  principal_id    TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  audit_id        TEXT NOT NULL REFERENCES audits (id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  label           TEXT CHECK (label IS NULL OR char_length(label) <= 120),
  allow_pdf       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  last_viewed_at  TIMESTAMPTZ,
  view_count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS report_shares_audit_idx ON report_shares (audit_id, created_at DESC);

-- ── 7. Server-only access ──
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_batch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_shares ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles unavailable: skipping API privilege revokes for 006 tables.';
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['billing_events','credit_accounts','credit_ledger','prospects','audit_batches','audit_batch_items','report_shares'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
  -- Identity sequence of credit_ledger.
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
END $$;
