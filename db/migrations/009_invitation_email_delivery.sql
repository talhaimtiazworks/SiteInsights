-- 009: invitation email outcome tracking and recipient-side invitation lookup.
-- No migration is applied automatically by this source change; deployments
-- must use the repository's approved migration process after review.

ALTER TABLE organization_invitations
  ADD COLUMN IF NOT EXISTS email_delivery_status TEXT NOT NULL DEFAULT 'not_attempted'
    CHECK (email_delivery_status IN ('not_attempted','accepted','failed','unknown','not_configured'));
ALTER TABLE organization_invitations
  ADD COLUMN IF NOT EXISTS email_last_attempt_at TIMESTAMPTZ;
ALTER TABLE organization_invitations
  ADD COLUMN IF NOT EXISTS email_error_code TEXT
    CHECK (email_error_code IS NULL OR email_error_code ~ '^[a-z0-9_]{1,64}$');

-- Recipient inbox queries are restricted to the current server-confirmed
-- address and only active, unexpired invitations.
CREATE INDEX IF NOT EXISTS organization_invitations_pending_recipient_idx
  ON organization_invitations (lower(invited_email), expires_at DESC)
  WHERE status = 'pending';

-- Re-sends are audited distinctly from first-time invitations.
ALTER TABLE organization_activity
  DROP CONSTRAINT IF EXISTS organization_activity_event_type_check;
ALTER TABLE organization_activity
  ADD CONSTRAINT organization_activity_event_type_check CHECK (event_type IN (
    'organization_created','organization_renamed',
    'member_added','member_removed','member_left','member_role_changed','ownership_transferred',
    'invitation_sent','invitation_resent','invitation_accepted','invitation_rejected','invitation_revoked',
    'prospect_shared','prospect_unshared','prospect_assigned','prospect_updated'
  ));
