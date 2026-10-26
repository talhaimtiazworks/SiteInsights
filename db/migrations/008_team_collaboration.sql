-- 008: transactional team collaboration and the 1 MiB private logo bound.
-- No migration is applied automatically by this source change; deployments
-- must use the repository's approved migration process after review.

-- Keep the 1 MiB raw-file limit consistent with the maximum canonical JPEG
-- data URI (23-byte prefix + 1,398,104 base64 characters). The database
-- decodes the Base64 payload to enforce the exact raw-byte cap; application code
-- also validates canonical Base64, the PNG/JPEG signature and raster dimensions.
ALTER TABLE professional_profiles
  DROP CONSTRAINT IF EXISTS professional_profiles_logo_data_url_check;
ALTER TABLE professional_profiles
  ADD CONSTRAINT professional_profiles_logo_data_url_check
  CHECK (logo_data_url IS NULL OR (char_length(logo_data_url) <= 1398127 AND logo_data_url ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$' AND octet_length(decode(split_part(logo_data_url, ',', 2), 'base64')) <= 1048576));

-- A personal prospect can be explicitly shared with one organization and
-- assigned to one current member. Principal ownership (and its plan limits)
-- remains unchanged; leaving a team detaches the member's own shared rows.
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations (id) ON DELETE SET NULL;
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS assigned_to_user_id UUID REFERENCES profiles (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS prospects_organization_updated_idx ON prospects (organization_id, updated_at DESC) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS prospects_assignee_updated_idx ON prospects (assigned_to_user_id, updated_at DESC) WHERE assigned_to_user_id IS NOT NULL;
ALTER TABLE prospects DROP CONSTRAINT IF EXISTS prospects_assignee_requires_organization;
ALTER TABLE prospects ADD CONSTRAINT prospects_assignee_requires_organization
  CHECK (assigned_to_user_id IS NULL OR organization_id IS NOT NULL);

CREATE TABLE IF NOT EXISTS organization_invitations (
  id                   UUID PRIMARY KEY,
  organization_id      UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  invited_email        TEXT NOT NULL CHECK (char_length(invited_email) BETWEEN 3 AND 254 AND invited_email = lower(btrim(invited_email))),
  role                 TEXT NOT NULL CHECK (role IN ('admin','member')),
  token_hash           TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  invited_by_user_id   UUID REFERENCES profiles (id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','revoked','expired')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_by_user_id  UUID REFERENCES profiles (id) ON DELETE SET NULL,
  accepted_at          TIMESTAMPTZ,
  responded_at         TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_invitations_pending_email_idx
  ON organization_invitations (organization_id, lower(invited_email)) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS organization_invitations_org_status_idx
  ON organization_invitations (organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS organization_activity (
  id                BIGSERIAL PRIMARY KEY,
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  actor_user_id     UUID REFERENCES profiles (id) ON DELETE SET NULL,
  event_type        TEXT NOT NULL CHECK (event_type IN (
    'organization_created','organization_renamed',
    'member_added','member_removed','member_left','member_role_changed','ownership_transferred',
    'invitation_sent','invitation_accepted','invitation_rejected','invitation_revoked',
    'prospect_shared','prospect_unshared','prospect_assigned','prospect_updated'
  )),
  subject_user_id   UUID REFERENCES profiles (id) ON DELETE SET NULL,
  prospect_id       UUID REFERENCES prospects (id) ON DELETE SET NULL,
  details           JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS organization_activity_recent_idx
  ON organization_activity (organization_id, created_at DESC, id DESC);

-- Collaboration data is accessed only by the app's server-side repository,
-- which verifies the caller's organization membership/role on every request.
-- The Supabase Data API receives no direct table access.
ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_activity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE organization_invitations, organization_activity FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE organization_invitations, organization_activity FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE organization_invitations, organization_activity FROM authenticated;
  END IF;
END $$;
