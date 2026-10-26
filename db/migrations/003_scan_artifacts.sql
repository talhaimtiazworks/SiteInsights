-- Browser render and performance results (bounded JSON per page/strategy)
CREATE TABLE IF NOT EXISTS scan_artifacts (
  id          TEXT PRIMARY KEY,
  scan_id     TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('render','performance')),
  key         TEXT NOT NULL,
  data        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scan_id, kind, key)
);
CREATE INDEX IF NOT EXISTS scan_artifacts_scan_idx ON scan_artifacts (scan_id, kind);
