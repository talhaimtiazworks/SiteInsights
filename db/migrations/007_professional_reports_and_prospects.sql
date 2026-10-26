-- 007: authenticated professional profiles, explicit publication controls,
-- deterministic report snapshots, and manual prospect details.
-- All owner data stays server-only; direct Supabase Data API writes are not granted.

-- Remove the old direct avatar-column write grant. Profile/avatar identity is
-- controlled by the server and the trusted GitHub avatar policy only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE UPDATE ON public.profiles FROM authenticated;
    REVOKE UPDATE (avatar_url) ON public.profiles FROM authenticated;
    GRANT UPDATE (display_name) ON public.profiles TO authenticated;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS professional_profiles (
  user_id                 UUID PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
  profile_type            TEXT NOT NULL DEFAULT 'freelancer' CHECK (profile_type IN ('freelancer','agency')),
  professional_name       TEXT NOT NULL DEFAULT '' CHECK (char_length(professional_name) <= 100),
  business_name           TEXT NOT NULL DEFAULT '' CHECK (char_length(business_name) <= 120),
  job_title               TEXT NOT NULL DEFAULT '' CHECK (char_length(job_title) <= 100),
  headline                TEXT NOT NULL DEFAULT '' CHECK (char_length(headline) <= 180),
  biography               TEXT NOT NULL DEFAULT '' CHECK (char_length(biography) <= 2000),
  website_url             TEXT NOT NULL DEFAULT '' CHECK (char_length(website_url) <= 2048),
  contact_email           TEXT NOT NULL DEFAULT '' CHECK (char_length(contact_email) <= 254),
  contact_phone           TEXT NOT NULL DEFAULT '' CHECK (char_length(contact_phone) <= 50),
  location                TEXT NOT NULL DEFAULT '' CHECK (char_length(location) <= 120),
  public_fields           JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(public_fields) = 'array' AND jsonb_array_length(public_fields) <= 12),
  brand_colors            JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(brand_colors) = 'array' AND jsonb_array_length(brand_colors) <= 10),
  logo_data_url           TEXT CHECK (logo_data_url IS NULL OR (char_length(logo_data_url) <= 1398127 AND logo_data_url ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$' AND octet_length(decode(split_part(logo_data_url, ',', 2), 'base64')) <= 1048576)),
  onboarding_completed    BOOLEAN NOT NULL DEFAULT false,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS professional_services (
  id               UUID PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  title            TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  description      TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 1500),
  categories       JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(categories) = 'array' AND jsonb_array_length(categories) <= 7),
  keywords         JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(keywords) = 'array' AND jsonb_array_length(keywords) <= 10),
  is_public        BOOLEAN NOT NULL DEFAULT false,
  sort_order       INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 49),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX IF NOT EXISTS professional_services_user_order_idx ON professional_services (user_id, sort_order, id);

CREATE TABLE IF NOT EXISTS professional_portfolio_items (
  id               UUID PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  title            TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  project_url      TEXT NOT NULL CHECK (char_length(project_url) BETWEEN 1 AND 2048),
  description      TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 1200),
  service_ids      JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(service_ids) = 'array' AND jsonb_array_length(service_ids) <= 20),
  categories       JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(categories) = 'array' AND jsonb_array_length(categories) <= 7),
  is_public        BOOLEAN NOT NULL DEFAULT false,
  sort_order       INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 49),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX IF NOT EXISTS professional_portfolio_user_order_idx ON professional_portfolio_items (user_id, sort_order, id);

-- Each new client link pins an immutable, server-built report and the exact
-- explicitly published professional data used when it was created. Legacy
-- links keep snapshot_id NULL and continue rendering their original live view.
CREATE TABLE IF NOT EXISTS client_report_snapshots (
  id             UUID PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  audit_id       TEXT NOT NULL REFERENCES audits (id) ON DELETE CASCADE,
  version        INTEGER NOT NULL CHECK (version > 0),
  content        JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audit_id, user_id, version)
);
CREATE INDEX IF NOT EXISTS client_report_snapshots_owner_audit_idx ON client_report_snapshots (user_id, audit_id, version DESC);
ALTER TABLE report_shares
  ADD COLUMN IF NOT EXISTS snapshot_id UUID REFERENCES client_report_snapshots (id) ON DELETE CASCADE;

-- Prospect discovery has no configured authorized provider by default. These
-- are details the owner enters or imports; nothing is scraped or inferred.
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS business_name TEXT CHECK (business_name IS NULL OR char_length(business_name) <= 160);
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS location TEXT CHECK (location IS NULL OR char_length(location) <= 160);

ALTER TABLE professional_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_portfolio_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_report_snapshots ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE professional_profiles, professional_services, professional_portfolio_items, client_report_snapshots FROM PUBLIC;
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['professional_profiles','professional_services','professional_portfolio_items','client_report_snapshots'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;
