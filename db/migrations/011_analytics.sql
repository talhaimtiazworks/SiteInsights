-- 011: First-party website analytics events for the private owner dashboard.
--
-- DESIGN NOTES (docs/ANALYTICS.md documents counting + privacy decisions):
--   * One append-mostly table of privacy-conscious events. Raw IP addresses and
--     visitor/session ids are never stored — the app stores salted HMAC hashes,
--     same convention as the existing ip_hash columns.
--   * client_event_id carries a UNIQUE constraint so at-least-once client
--     delivery (sendBeacon retries, flaky networks) can never duplicate a
--     logical event.
--   * Indexes support the dashboard's bounded range scans and group-bys.
--   * Row Level Security is enabled and no access is granted to API roles:
--     analytics rows are reachable ONLY through the app's server-side
--     repository, which itself enforces the single-email owner allowlist.

CREATE TABLE IF NOT EXISTS analytics_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_event_id  TEXT NOT NULL UNIQUE CHECK (client_event_id ~ '^[0-9a-f-]{36}$'),
  visitor_hash     TEXT NOT NULL CHECK (char_length(visitor_hash) BETWEEN 16 AND 64),
  session_hash     TEXT NOT NULL CHECK (char_length(session_hash) BETWEEN 16 AND 64),
  event_type       TEXT NOT NULL CHECK (event_type IN ('pageview','session_start')),
  path             TEXT NOT NULL CHECK (char_length(path) BETWEEN 1 AND 200 AND path ~ '^/'),
  referrer_host    TEXT CHECK (referrer_host IS NULL OR referrer_host = lower(referrer_host)),
  source           TEXT NOT NULL DEFAULT 'direct' CHECK (source IN ('direct','search','social','referral','campaign','other')),
  device           TEXT NOT NULL DEFAULT 'unknown' CHECK (device IN ('desktop','mobile','tablet','unknown')),
  browser          TEXT NOT NULL DEFAULT 'unknown',
  os               TEXT NOT NULL DEFAULT 'unknown',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bounded range scans + the dashboard's group-bys.
CREATE INDEX IF NOT EXISTS analytics_events_created_idx ON analytics_events (created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_source_created_idx ON analytics_events (source, created_at);
CREATE INDEX IF NOT EXISTS analytics_events_device_created_idx ON analytics_events (device, created_at);
CREATE INDEX IF NOT EXISTS analytics_events_path_created_idx ON analytics_events (path, created_at);
CREATE INDEX IF NOT EXISTS analytics_events_session_created_idx ON analytics_events (session_hash, created_at);
CREATE INDEX IF NOT EXISTS analytics_events_visitor_created_idx ON analytics_events (visitor_hash, created_at);

-- No direct access through the Supabase Data API; the app server holds the only key.
ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE analytics_events FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE analytics_events FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE analytics_events FROM authenticated;
  END IF;
END $$;

-- Retention (documentary): events older than 400 days are eligible for the
-- documented cleanup in docs/ANALYTICS.md. No cron is created here because the
-- schema layer has no scheduling context; operators run the documented DELETE.
