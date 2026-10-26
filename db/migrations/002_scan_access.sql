-- Scan access keys and idempotent scan creation
ALTER TABLE scans ADD COLUMN IF NOT EXISTS access_key_hash TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS scans_idempotency_idx ON scans (principal_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
