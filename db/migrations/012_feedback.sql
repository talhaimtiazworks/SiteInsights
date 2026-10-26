-- 012: Account-based user feedback with one-time third-audit invitation state
-- and safe email-delivery bookkeeping.
--
-- DESIGN NOTES
--   * feedback_submissions is append-mostly: a row is created BEFORE the email
--     send is attempted, so a temporary provider failure never silently loses
--     the feedback. delivery_status records the provider's verdict only —
--     'accepted' means the provider accepted the message; nothing else is
--     ever reported to the user as success.
--   * (user_id, idempotency_key) is UNIQUE so a retried submit (double-click,
--     flaky network) records — and later sends — the logical feedback at most
--     once. Retries reuse the same row; deliveries with an uncertain outcome
--     are never re-sent (see services/feedback.ts).
--   * feedback_prompts holds the one-time "leave us feedback" invitation
--     offered after the account's third completed audit. One row per user:
--     first creation is an INSERT ... ON CONFLICT DO NOTHING, so concurrent
--     audit completions cannot invite twice.
--   * Row Level Security is enabled and no access is granted to API roles:
--     rows are reachable only through the app's server-side repository, which
--     scopes every query to the request's verified user id.

CREATE TABLE IF NOT EXISTS feedback_submissions (
  id                   TEXT PRIMARY KEY,
  user_id              UUID NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  principal_id         TEXT NOT NULL,
  account_email        TEXT,
  category             TEXT NOT NULL CHECK (category IN ('general','bug','feature','other')),
  rating               SMALLINT CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  message              TEXT NOT NULL CHECK (char_length(message) BETWEEN 20 AND 4000),
  goal                 TEXT CHECK (goal IS NULL OR char_length(goal) BETWEEN 1 AND 1000),
  page_url             TEXT CHECK (page_url IS NULL OR (char_length(page_url) <= 300 AND page_url ~ '^/')),
  delivery_status      TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','accepted','failed')),
  delivery_error_code  TEXT CHECK (delivery_error_code IS NULL OR delivery_error_code ~ '^[a-z0-9_]{1,64}$'),
  provider_message_id  TEXT CHECK (provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 200),
  outcome_uncertain    BOOLEAN NOT NULL DEFAULT false,
  idempotency_key      TEXT NOT NULL CHECK (idempotency_key ~ '^[0-9a-f-]{36}$'),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS feedback_submissions_user_created_idx ON feedback_submissions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_submissions_delivery_idx ON feedback_submissions (delivery_status) WHERE delivery_status <> 'accepted';

CREATE TABLE IF NOT EXISTS feedback_prompts (
  user_id           UUID PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
  state             TEXT NOT NULL DEFAULT 'offered' CHECK (state IN ('offered','remind_later','dismissed')),
  first_offered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  remind_after      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No direct access through the Supabase Data API; the app server holds the only key.
ALTER TABLE feedback_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_prompts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE feedback_submissions, feedback_prompts FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE feedback_submissions, feedback_prompts FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE feedback_submissions, feedback_prompts FROM authenticated;
  END IF;
END $$;
