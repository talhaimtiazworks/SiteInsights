-- SiteLens AI initial schema
CREATE TABLE IF NOT EXISTS principals (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'anonymous',
  plan          TEXT NOT NULL DEFAULT 'free',
  ip_hash       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS websites (
  id               TEXT PRIMARY KEY,
  origin           TEXT NOT NULL UNIQUE,
  hostname         TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_scanned_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scans (
  id            TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  website_id    TEXT REFERENCES websites(id) ON DELETE SET NULL,
  target_url    TEXT NOT NULL,
  hostname      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('queued','running','completed','completed_with_warnings','failed','cancelled')),
  phase         TEXT NOT NULL,
  limits        JSONB NOT NULL,
  progress      JSONB NOT NULL,
  state         JSONB NOT NULL,
  warnings      JSONB NOT NULL DEFAULT '[]'::jsonb,
  error         JSONB,
  summary       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS scans_principal_created_idx ON scans (principal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS scans_status_updated_idx ON scans (status, updated_at);

CREATE TABLE IF NOT EXISTS scan_pages (
  id           TEXT PRIMARY KEY,
  scan_id      TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  final_url    TEXT NOT NULL,
  status_code  INTEGER,
  depth        INTEGER NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL,
  data         JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS scan_pages_scan_idx ON scan_pages (scan_id);

CREATE TABLE IF NOT EXISTS link_checks (
  id            TEXT PRIMARY KEY,
  scan_id       TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  kind          TEXT NOT NULL,
  is_internal   BOOLEAN NOT NULL,
  category      TEXT NOT NULL,
  verification  TEXT NOT NULL,
  status_code   INTEGER,
  checked_at    TIMESTAMPTZ NOT NULL,
  data          JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS link_checks_scan_idx ON link_checks (scan_id, category);

CREATE TABLE IF NOT EXISTS findings (
  id            TEXT PRIMARY KEY,
  scan_id       TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  rule_id       TEXT NOT NULL,
  category      TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  affected_url  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  data          JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_scan_idx ON findings (scan_id, severity);

CREATE TABLE IF NOT EXISTS ai_recommendations (
  id             TEXT PRIMARY KEY,
  scan_id        TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  finding_key    TEXT NOT NULL,
  provider       TEXT NOT NULL CHECK (provider IN ('openrouter','gemini')),
  model          TEXT NOT NULL,
  fallback_from  TEXT,
  content        JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scan_id, finding_key)
);

CREATE TABLE IF NOT EXISTS usage_events (
  id            BIGSERIAL PRIMARY KEY,
  principal_id  TEXT NOT NULL,
  ip_hash       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  amount        INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_principal_idx ON usage_events (kind, principal_id, created_at);
CREATE INDEX IF NOT EXISTS usage_events_ip_idx ON usage_events (kind, ip_hash, created_at);

-- Provider configuration REFERENCES only. API keys are never stored in the database.
CREATE TABLE IF NOT EXISTS provider_preferences (
  principal_id  TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK (provider IN ('openrouter','gemini')),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
