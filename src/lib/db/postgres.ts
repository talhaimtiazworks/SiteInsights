import "server-only";
import postgres from "postgres";
import type { Finding } from "../audit/types";
import type { ProviderId } from "../config/env";
import { logger } from "../logger";
import type { LinkCheckRecord, PageRecord, ScanJob, ScanStatus } from "../scanner/types";
import { classifyDatabaseError, DatabaseProblemError, type DatabaseProblem } from "./errors";
import { MIGRATIONS } from "./migrations";
import { computeOverallScore, type AuditMetric } from "../audit/metrics";
import type { ResolutionStatus } from "../audit/types";
import { MAX_ORGANIZATION_MEMBERS, MAX_OWNED_ORGANIZATIONS_PER_USER, type AccountRepository, type FeedbackDeliveryStatus, type FeedbackPromptRow, type FeedbackSubmissionRow, type NewFeedbackSubmission, type Organization, type OrganizationActivity, type OrganizationInvitation, type OrganizationInvitationEmailStatus, type OrganizationInvitationPreview, type RecipientOrganizationInvitation, type OrganizationMember, type OrganizationMemberWithOrganization, type OrganizationSummary, type OrgRole, type PlanRow, type Profile, type SubscriptionInfo, type UserSettings } from "./account-types";
import type { ProfessionalData, ProfessionalDataInput, ProfessionalPortfolioItem, ProfessionalProfile, ProfessionalService } from "../professional/types";
import { normalizeStoredBrandColors } from "../professional/brand-colors";
import {
  DuplicateScanError,
  type AiRecommendationRecord,
  type ArtifactKind,
  type AuditQuery,
  type AuditStats,
  type HistoryEvent,
  type LatestIssue,
  type Repository,
  type RunnableScan,
  type ScanArtifact,
  type ScanListItem,
  type UsageConsumeInput,
  type UsageConsumeResult,
  type UsageCount,
  type UsageKind,
} from "./types";

import { PostgresCommerce } from "./commerce-postgres";
import { PostgresAnalytics } from "./analytics-postgres";
import { randomUUID } from "node:crypto";
import { grantsPaidAccess, reduceSubscription } from "../billing/reducer";
import type { ApplyBillingResult, NormalizedBillingEvent, StoredSubscription } from "../billing/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const rowToSubscriptionInfo = (r: any): SubscriptionInfo => ({
  id: r.id,
  planId: r.plan_id,
  status: r.status,
  provider: r.provider ?? null,
  currentPeriodStart: r.current_period_start ? new Date(r.current_period_start).toISOString() : null,
  currentPeriodEnd: r.current_period_end ? new Date(r.current_period_end).toISOString() : null,
  cancelAt: r.cancel_at ? new Date(r.cancel_at).toISOString() : null,
  cancelAtPeriodEnd: !!r.cancel_at_period_end,
});
const d = (v: any) => (v ? new Date(v) : null);
const rowToStoredSubscription = (r: any): StoredSubscription => ({
  id: r.id,
  userId: r.user_id,
  planId: r.plan_id,
  status: r.status,
  provider: r.provider,
  providerReference: r.provider_reference,
  currentPeriodStart: d(r.current_period_start),
  currentPeriodEnd: d(r.current_period_end),
  cancelAt: d(r.cancel_at),
  cancelAtPeriodEnd: !!r.cancel_at_period_end,
  endedAt: d(r.ended_at),
  lastEventAt: d(r.last_event_at),
});
/* eslint-enable @typescript-eslint/no-explicit-any */
export { DatabaseProblemError } from "./errors";

/** Connection-level failure (kept for existing callers; a DatabaseProblemError with problem "database_unavailable"). */
export class DatabaseUnavailableError extends DatabaseProblemError {
  constructor(context: Record<string, unknown> = {}) {
    super("database_unavailable", context);
  }
}

/** Result of a live database probe (status / diagnostics). Contains no values or secrets. */
export interface DatabaseHealth {
  ok: boolean;
  problem: DatabaseProblem | null;
  /** Migration versions this build expects but the database lacks. */
  missingMigrations: string[];
  /** Whether the database has a Supabase auth.users table (i.e. it is a Supabase project database). */
  supabaseAuthSchema: boolean | null;
  /** Whether the database URL is used for migrations or a separate session/direct URL is. */
  migrationConnection: "runtime" | "separate";
}

type Sql = postgres.Sql;
type Json = postgres.JSONValue;
const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const j = (v: unknown) => v as Json;

function sslOption(url: string, mode: "require" | "disable" | "prefer" | null): postgres.Options<Record<string, never>>["ssl"] {
  if (mode === "disable") return false;
  if (mode) return mode;
  if (/sslmode=/.test(url)) return undefined; // let the driver honour the URL
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) return false;
  return "require";
}

interface ScanRow {
  id: string;
  principal_id: string;
  website_id: string | null;
  target_url: string;
  hostname: string;
  status: ScanStatus;
  phase: ScanJob["phase"];
  limits: ScanJob["limits"];
  progress: ScanJob["progress"];
  state: ScanJob["state"];
  warnings: string[];
  error: ScanJob["error"];
  summary: ScanJob["summary"];
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
  access_key_hash: string | null;
  idempotency_key: string | null;
  title: string | null;
  rerun_of: string | null;
  organization_id: string | null;
  overall_score: number | null;
  ip_hash: string | null;
}

function rowToScan(r: ScanRow): ScanJob {
  return {
    id: r.id,
    principalId: r.principal_id,
    websiteId: r.website_id,
    targetUrl: r.target_url,
    hostname: r.hostname,
    status: r.status,
    phase: r.phase,
    limits: r.limits,
    progress: r.progress,
    state: r.state,
    warnings: r.warnings ?? [],
    error: r.error,
    summary: r.summary,
    createdAt: iso(r.created_at)!,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    updatedAt: iso(r.updated_at)!,
    access: { keyHash: r.access_key_hash ?? null, idempotencyKey: r.idempotency_key ?? null },
    title: r.title ?? null,
    rerunOf: r.rerun_of ?? null,
    organizationId: r.organization_id ?? null,
    overallScore: r.overall_score ?? null,
    ipHash: r.ip_hash ?? null,
  };
}

/** Columns for list views: everything except the large crawl state. */
const LIST_COLUMNS = "id, principal_id, website_id, target_url, hostname, status, phase, limits, progress, warnings, error, summary, created_at, started_at, finished_at, updated_at, access_key_hash, idempotency_key, title, rerun_of, organization_id, overall_score, ip_hash";

function rowToListItem(r: Omit<ScanRow, "state">): ScanListItem {
  const { state: _s, ...rest } = rowToScan({ ...r, state: null as never });
  void _s;
  return rest;
}

type ProfileRow = { id: string; email: string | null; display_name: string | null; created_at: Date; updated_at: Date };
const rowToProfile = (r: ProfileRow): Profile => ({ id: r.id, email: r.email, displayName: r.display_name, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)! });

interface FeedbackSubmissionRowRaw {
  id: string; user_id: string; principal_id: string; account_email: string | null;
  category: FeedbackSubmissionRow["category"]; rating: number | null; message: string; goal: string | null; page_url: string | null;
  delivery_status: FeedbackDeliveryStatus; delivery_error_code: string | null; provider_message_id: string | null;
  outcome_uncertain: boolean; idempotency_key: string; created_at: string; updated_at: string;
}
interface FeedbackPromptRowRaw { user_id: string; state: FeedbackPromptRow["state"]; first_offered_at: string; remind_after: string | null; updated_at: string }

const rowToFeedbackSubmission = (r: FeedbackSubmissionRowRaw): FeedbackSubmissionRow => ({
  id: r.id, userId: r.user_id, principalId: r.principal_id, accountEmail: r.account_email,
  category: r.category, rating: r.rating === null ? null : Number(r.rating), message: r.message, goal: r.goal, pageUrl: r.page_url,
  deliveryStatus: r.delivery_status, deliveryErrorCode: r.delivery_error_code, providerMessageId: r.provider_message_id,
  outcomeUncertain: r.outcome_uncertain, idempotencyKey: r.idempotency_key, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
});
const rowToFeedbackPrompt = (r: FeedbackPromptRowRaw): FeedbackPromptRow => ({
  userId: r.user_id, state: r.state, firstOfferedAt: iso(r.first_offered_at)!, remindAfter: iso(r.remind_after), updatedAt: iso(r.updated_at)!,
});
type OrganizationInvitationRow = {
  id: string;
  organization_id: string;
  invited_email: string;
  role: "admin" | "member";
  status: OrganizationInvitation["status"];
  created_at: Date;
  expires_at: Date;
  invited_by_user_id: string | null;
  accepted_at: Date | null;
  email_delivery_status: OrganizationInvitationEmailStatus;
  email_last_attempt_at: Date | null;
  email_error_code: string | null;
};
const rowToOrganizationInvitation = (r: OrganizationInvitationRow): OrganizationInvitation => ({
  id: r.id,
  organizationId: r.organization_id,
  email: r.invited_email,
  role: r.role,
  status: r.status,
  createdAt: iso(r.created_at)!,
  expiresAt: iso(r.expires_at)!,
  invitedByUserId: r.invited_by_user_id,
  acceptedAt: iso(r.accepted_at),
  emailDeliveryStatus: r.email_delivery_status ?? "not_attempted",
  emailLastAttemptAt: iso(r.email_last_attempt_at),
  emailErrorCode: r.email_error_code,
});
const rowToRecipientInvitation = (r: OrganizationInvitationRow & { organization_name: string; inviter_name: string | null; inviter_email: string | null }): RecipientOrganizationInvitation => ({
  id: r.id,
  organizationId: r.organization_id,
  organizationName: r.organization_name,
  email: r.invited_email,
  role: r.role,
  status: r.status,
  createdAt: iso(r.created_at)!,
  expiresAt: iso(r.expires_at)!,
  invitedByName: r.inviter_name,
  invitedByEmail: r.inviter_email,
});
const rowToInvitationPreview = (r: OrganizationInvitationRow & { organization_name: string; inviter_name: string | null; inviter_email: string | null }): OrganizationInvitationPreview => ({
  ...rowToRecipientInvitation(r),
  emailDeliveryStatus: r.email_delivery_status ?? "not_attempted",
});
type OrganizationActivityRow = { id: string | number; event_type: string; actor_name: string | null; actor_email: string | null; subject_name: string | null; subject_email: string | null; prospect_hostname: string | null; details: Record<string, unknown> | null; created_at: Date };
const rowToOrganizationActivity = (r: OrganizationActivityRow): OrganizationActivity => {
  const privateDecline = r.event_type === "invitation_rejected";
  const details = { ...(r.details ?? {}) };
  if (r.event_type.startsWith("invitation_")) delete details.email;
  return {
    id: String(r.id),
    event: r.event_type,
    actorName: privateDecline ? null : r.actor_name,
    actorEmail: privateDecline ? null : r.actor_email,
    subjectName: privateDecline ? null : r.subject_name,
    subjectEmail: privateDecline ? null : r.subject_email,
    prospectHostname: r.prospect_hostname,
    details,
    createdAt: iso(r.created_at)!,
  };
};
type ProfessionalProfileRow = {
  profile_type: ProfessionalProfile["profileType"];
  professional_name: string;
  business_name: string;
  job_title: string;
  headline: string;
  biography: string;
  website_url: string;
  contact_email: string;
  contact_phone: string;
  location: string;
  public_fields: unknown;
  brand_colors: unknown;
  logo_data_url: string | null;
  onboarding_completed: boolean;
  updated_at: Date;
};
type ProfessionalServiceRow = { id: string; title: string; description: string; categories: unknown; keywords: unknown; is_public: boolean; sort_order: number };
type ProfessionalPortfolioRow = { id: string; title: string; project_url: string; description: string; service_ids: unknown; categories: unknown; is_public: boolean; sort_order: number };
const jsonArray = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
const defaultProfessionalProfile = (): ProfessionalProfile => ({
  profileType: "freelancer", professionalName: "", businessName: "", jobTitle: "", headline: "", biography: "", websiteUrl: "", contactEmail: "", contactPhone: "", location: "",
  publicFields: [], brandColors: [], logoDataUrl: null, onboardingCompleted: false, updatedAt: null,
});
const rowToProfessionalData = (p: ProfessionalProfileRow | undefined, services: ProfessionalServiceRow[], portfolio: ProfessionalPortfolioRow[]): ProfessionalData => ({
  profile: p ? {
    profileType: p.profile_type,
    professionalName: p.professional_name,
    businessName: p.business_name,
    jobTitle: p.job_title,
    headline: p.headline,
    biography: p.biography,
    websiteUrl: p.website_url,
    contactEmail: p.contact_email,
    contactPhone: p.contact_phone,
    location: p.location,
    publicFields: jsonArray<ProfessionalProfile["publicFields"][number]>(p.public_fields),
    brandColors: normalizeStoredBrandColors(p.brand_colors),
    logoDataUrl: p.logo_data_url,
    onboardingCompleted: p.onboarding_completed,
    updatedAt: iso(p.updated_at),
  } : defaultProfessionalProfile(),
  services: services.map((s) => ({ id: s.id, title: s.title, description: s.description, categories: jsonArray<ProfessionalService["categories"][number]>(s.categories), keywords: jsonArray<string>(s.keywords), isPublic: s.is_public, sortOrder: s.sort_order })),
  portfolio: portfolio.map((p) => ({ id: p.id, title: p.title, projectUrl: p.project_url, description: p.description, serviceIds: jsonArray<string>(p.service_ids), categories: jsonArray<ProfessionalPortfolioItem["categories"][number]>(p.categories), isPublic: p.is_public, sortOrder: p.sort_order })),
});
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const ACTIVE_STATUSES = ["queued", "running"];

export class PostgresRepository implements Repository, AccountRepository {
  readonly kind = "postgres" as const;
  readonly persistent = true;
  private sql: Sql;
  private ready: Promise<void> | null = null;
  readonly commerce: PostgresCommerce = new PostgresCommerce((fn) => this.q(fn as never));
  readonly analytics: PostgresAnalytics = new PostgresAnalytics((fn) => this.q(fn as never));

  constructor(
    url: string,
    private opts: {
      ssl: "require" | "disable" | "prefer" | null;
      autoMigrate: boolean;
      /** Session-mode/direct connection for migrations (same database). Runtime traffic always uses `url`. */
      migrationUrl?: string | null;
    },
  ) {
    this.sql = postgres(url, {
      ssl: sslOption(url, opts.ssl),
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false, // compatible with transaction-mode poolers (PgBouncer, Supabase, Neon pooler)
      onnotice: () => {},
    });
  }

  /** Closes the connection pool (tests / scripts). */
  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  /**
   * Runs once per server instance before the first query: applies pending
   * migrations (when DB_AUTO_MIGRATE is on), then verifies that every migration
   * this build needs is present and that the runtime role can use the tables.
   * Failures are classified (missing schema, outdated schema, permissions,
   * unreachable …) instead of surfacing later as a generic 500.
   */
  private async init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        try {
          if (this.opts.autoMigrate) {
            try {
              await this.migrate();
            } catch (err) {
              const problem = classifyDatabaseError(err);
              // Unreachable / bad credentials / busy are reported as such; anything else is a failed migration.
              if (problem && ["database_unavailable", "database_misconfigured", "database_busy", "database_permission_denied", "database_read_only"].includes(problem)) throw err;
              throw new DatabaseProblemError("database_migration_failed", { pgCode: (err as { code?: string })?.code ?? null });
            }
          }
          const health = await this.verifySchema(this.sql);
          if (health.problem) throw new DatabaseProblemError(health.problem, { missingMigrations: health.missingMigrations });
        } catch (err) {
          this.ready = null;
          const problem = classifyDatabaseError(err) ?? "database_unavailable";
          const e = err instanceof DatabaseProblemError && err.problem === problem ? err : new DatabaseProblemError(problem, { pgCode: (err as { code?: string })?.code ?? null });
          logger.error(`Database initialisation failed (${problem}). ${e.info.hint}`, { ...e.context, cause: err instanceof DatabaseProblemError ? undefined : err });
          throw e;
        }
      })();
    }
    return this.ready;
  }

  /** Checks applied migrations and table privileges; never modifies anything. */
  private async verifySchema(sql: Sql): Promise<Pick<DatabaseHealth, "problem" | "missingMigrations" | "supabaseAuthSchema">> {
    const [meta] = await sql<{ has_migrations: boolean; has_audits: boolean; has_auth: boolean }[]>`
      SELECT to_regclass('public.schema_migrations') IS NOT NULL AS has_migrations,
             to_regclass('public.audits') IS NOT NULL AS has_audits,
             to_regclass('auth.users') IS NOT NULL AS has_auth`;
    const all = MIGRATIONS.map((m) => m.version);
    if (!meta.has_migrations) {
      return { problem: meta.has_audits ? "database_schema_outdated" : "database_schema_missing", missingMigrations: all, supabaseAuthSchema: meta.has_auth };
    }
    const rows = await sql<{ version: string }[]>`SELECT version::text AS version FROM public.schema_migrations`;
    const applied = new Set(rows.map((r) => r.version));
    const missing = all.filter((v) => !applied.has(v));
    if (missing.length === all.length) return { problem: meta.has_audits ? "database_schema_outdated" : "database_schema_missing", missingMigrations: missing, supabaseAuthSchema: meta.has_auth };
    if (missing.length || !meta.has_audits) return { problem: "database_schema_outdated", missingMigrations: missing, supabaseAuthSchema: meta.has_auth };
    const [priv] = await sql<{ ok: boolean }[]>`
      SELECT has_table_privilege('public.audits', 'SELECT, INSERT, UPDATE, DELETE')
         AND has_table_privilege('public.principals', 'SELECT, INSERT, UPDATE')
         AND has_table_privilege('public.usage_records', 'SELECT, INSERT') AS ok`;
    if (!priv.ok) return { problem: "database_permission_denied", missingMigrations: [], supabaseAuthSchema: meta.has_auth };
    return { problem: null, missingMigrations: [], supabaseAuthSchema: meta.has_auth };
  }

  /** Live probe for /api/system/status and diagnostics. Never throws. */
  async health(): Promise<DatabaseHealth> {
    const migrationConnection = this.opts.migrationUrl ? "separate" : "runtime";
    try {
      await this.init();
      const r = await this.verifySchema(this.sql);
      return { ok: !r.problem, ...r, migrationConnection };
    } catch (err) {
      const problem = classifyDatabaseError(err) ?? "database_unavailable";
      const missing = err instanceof DatabaseProblemError && Array.isArray(err.context.missingMigrations) ? (err.context.missingMigrations as string[]) : [];
      return { ok: false, problem, missingMigrations: missing, supabaseAuthSchema: null, migrationConnection };
    }
  }

  /**
   * Whether a Supabase Auth user id can own a profile in THIS database — i.e.
   * the profiles → auth.users foreign key accepts it. Tested exactly the way
   * sign-in uses it (an INSERT), inside a transaction that is always rolled
   * back, so nothing is written. A plain SELECT on auth.users is not reliable:
   * RLS on auth.users hides rows from roles without BYPASSRLS.
   * Returns null when the database has no such foreign key (not a Supabase database).
   */
  async authUserLinkable(id: string): Promise<boolean | null> {
    const [m] = await this.q((sql) => sql<{ fk: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_id_auth_users_fkey') AS fk`);
    if (!m.fk) return null;
    const ROLLBACK = Symbol("rollback");
    try {
      await this.sql.begin(async (tx) => {
        await tx`INSERT INTO profiles (id) VALUES (${id}::uuid) ON CONFLICT (id) DO NOTHING`;
        throw ROLLBACK;
      });
    } catch (err) {
      if (err === ROLLBACK) return true;
      if ((err as { code?: string })?.code === "23503") return false;
      throw err;
    }
    return true;
  }

  /**
   * Applies pending migrations (idempotent: one transaction per migration,
   * serialised by an advisory lock, recorded in schema_migrations). Uses the
   * separate session/direct connection when configured — transaction poolers
   * are meant for short runtime queries, not DDL.
   */
  async migrate(): Promise<string[]> {
    const url = this.opts.migrationUrl;
    if (url) {
      const sep = postgres(url, { ssl: sslOption(url, this.opts.ssl), max: 1, connect_timeout: 10, prepare: false, onnotice: () => {} });
      try {
        return await this.applyMigrations(sep);
      } catch (err) {
        // The session/direct URL may be unreachable from this host; the runtime connection works for DDL too.
        if (classifyDatabaseError(err) !== "database_unavailable") throw err;
        logger.warn("The migration connection could not be reached; applying migrations over the runtime connection instead.");
      } finally {
        await sep.end({ timeout: 5 }).catch(() => {});
      }
    }
    return this.applyMigrations(this.sql);
  }

  private async applyMigrations(sql: Sql): Promise<string[]> {
    const applied: string[] = [];
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    for (const m of MIGRATIONS) {
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('sitelens_migrations'))`;
        const done = await tx`SELECT 1 FROM schema_migrations WHERE version = ${m.version}`;
        if (done.length) return;
        try {
          await tx.unsafe(m.sql);
        } catch (err) {
          logger.error(`Migration ${m.version} failed`, err);
          throw err;
        }
        await tx`INSERT INTO schema_migrations (version) VALUES (${m.version})`;
        applied.push(m.version);
      });
    }
    if (applied.length) logger.info(`Applied database migrations: ${applied.join(", ")}`);
    return applied;
  }

  private async q<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    await this.init();
    try {
      return await fn(this.sql);
    } catch (err) {
      const problem = classifyDatabaseError(err);
      if (!problem) throw err; // a genuine bug: logged by errorResponse as internal_error
      if (problem === "database_schema_outdated" || problem === "database_permission_denied") this.ready = null; // re-verify on the next request
      const e = new DatabaseProblemError(problem, { pgCode: (err as { code?: string })?.code ?? null });
      logger.error(`Database query failed (${problem}). ${e.info.hint}`, err);
      throw e;
    }
  }

  async ensurePrincipal(id: string, ipHash: string) {
    await this.q((sql) => sql`INSERT INTO principals (id, ip_hash) VALUES (${id}, ${ipHash}) ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), ip_hash = EXCLUDED.ip_hash`);
  }

  async upsertWebsite(origin: string, hostname: string) {
    return this.q(async (sql) => {
      const rows = await sql<{ id: string }[]>`
        INSERT INTO websites (id, origin, hostname) VALUES (${crypto.randomUUID()}, ${origin}, ${hostname})
        ON CONFLICT (origin) DO UPDATE SET last_scanned_at = now() RETURNING id`;
      return rows[0].id;
    });
  }

  async createScan(s: ScanJob) {
    try {
      await this.q((sql) => sql`
        INSERT INTO audits (id, principal_id, website_id, target_url, hostname, status, phase, limits, progress, state, warnings, error, summary, created_at, started_at, finished_at, updated_at, access_key_hash, idempotency_key, title, rerun_of, ip_hash)
        VALUES (${s.id}, ${s.principalId}, ${s.websiteId}, ${s.targetUrl}, ${s.hostname}, ${s.status}, ${s.phase}, ${sql.json(j(s.limits))}, ${sql.json(j(s.progress))}, ${sql.json(j(s.state))},
                ${sql.json(j(s.warnings))}, ${s.error ? sql.json(j(s.error)) : null}, ${s.summary ? sql.json(j(s.summary)) : null}, ${s.createdAt}, ${s.startedAt}, ${s.finishedAt}, now(),
                ${s.access?.keyHash ?? null}, ${s.access?.idempotencyKey ?? null}, ${s.title ?? null}, ${s.rerunOf ?? null}, ${s.ipHash ?? null})`);
    } catch (err) {
      const constraint = String((err as { constraint_name?: string }).constraint_name ?? (err as Error).message);
      // Audits created with an Idempotency-Key derive their id from it, so a primary-key clash is also a duplicate request.
      if ((err as { code?: string }).code === "23505" && (/idempotency/.test(constraint) || (/_pkey/.test(constraint) && !!s.access?.idempotencyKey))) {
        throw new DuplicateScanError();
      }
      throw err;
    }
  }

  async findScanByIdempotencyKey(principalId: string, key: string) {
    return this.q(async (sql) => {
      const rows = await sql<ScanRow[]>`SELECT * FROM audits WHERE principal_id = ${principalId} AND idempotency_key = ${key}`;
      return rows[0] ? rowToScan(rows[0]) : null;
    });
  }

  async getScan(id: string) {
    return this.q(async (sql) => {
      const rows = await sql<ScanRow[]>`SELECT * FROM audits WHERE id = ${id}`;
      return rows[0] ? rowToScan(rows[0]) : null;
    });
  }

  async saveScan(s: ScanJob) {
    return this.q(async (sql) => {
      const rows = await sql`
        UPDATE audits SET status = ${s.status}, phase = ${s.phase}, progress = ${sql.json(j(s.progress))}, state = ${sql.json(j(s.state))},
          warnings = ${sql.json(j(s.warnings))}, error = ${s.error ? sql.json(j(s.error)) : null}, summary = ${s.summary ? sql.json(j(s.summary)) : null},
          started_at = ${s.startedAt}, finished_at = ${s.finishedAt}, overall_score = ${computeOverallScore(s.summary)}, updated_at = now()
        WHERE id = ${s.id} AND status IN ('queued', 'running') RETURNING id`;
      return rows.length > 0;
    });
  }

  async transitionScan(id: string, from: ScanStatus[], to: ScanStatus, patch: Partial<Pick<ScanJob, "error" | "finishedAt" | "phase">> = {}) {
    return this.q(async (sql) => {
      const rows = await sql`
        UPDATE audits SET status = ${to},
          error = COALESCE(${patch.error ? sql.json(j(patch.error)) : null}, error),
          finished_at = COALESCE(${patch.finishedAt ?? null}, finished_at),
          phase = COALESCE(${patch.phase ?? null}, phase),
          updated_at = now()
        WHERE id = ${id} AND status IN ${sql(from)} RETURNING id`;
      return rows.length > 0;
    });
  }

  async listScans(principalId: string, limit: number) {
    return this.q(async (sql) => {
      const rows = await sql<ScanRow[]>`SELECT * FROM audits WHERE principal_id = ${principalId} ORDER BY created_at DESC LIMIT ${limit}`;
      return rows.map(rowToScan);
    });
  }

  async countActiveScans(opts: { principalId?: string; activeSince: Date }) {
    return this.q(async (sql) => {
      const rows = opts.principalId
        ? await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audits WHERE status IN ('queued','running') AND updated_at >= ${opts.activeSince} AND principal_id = ${opts.principalId}`
        : await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audits WHERE status IN ('queued','running') AND updated_at >= ${opts.activeSince}`;
      return rows[0]?.n ?? 0;
    });
  }

  async acquireLease(id: string, ms: number) {
    return this.q(async (sql) => {
      const rows = await sql`UPDATE audits SET lease_until = now() + (${ms} * interval '1 millisecond'), attempts = attempts + 1 WHERE id = ${id} AND (lease_until IS NULL OR lease_until < now()) RETURNING id`;
      return rows.length > 0;
    });
  }

  async releaseLease(id: string) {
    await this.q((sql) => sql`UPDATE audits SET lease_until = NULL WHERE id = ${id}`);
  }

  async pruneHistory(principalId: string, keep: number) {
    return this.q(async (sql) => {
      const rows = await sql`
        DELETE FROM audits WHERE id IN (
          SELECT id FROM audits WHERE principal_id = ${principalId} AND status NOT IN ('queued','running')
          ORDER BY created_at DESC OFFSET ${keep}
        ) RETURNING id`;
      return rows.length;
    });
  }

  async saveArtifact(a: ScanArtifact) {
    await this.q((sql) => sql`INSERT INTO audit_artifacts (id, audit_id, kind, key, data, created_at)
      VALUES (${a.id}, ${a.scanId}, ${a.kind}, ${a.key}, ${sql.json(j(a.data))}, ${a.createdAt})
      ON CONFLICT (audit_id, kind, key) DO UPDATE SET data = EXCLUDED.data, created_at = EXCLUDED.created_at`);
  }

  async listArtifacts(scanId: string, kind?: ArtifactKind) {
    type Row = { id: string; audit_id: string; kind: ArtifactKind; key: string; data: unknown; created_at: Date };
    return this.q(async (sql) => {
      const rows = kind
        ? await sql<Row[]>`SELECT * FROM audit_artifacts WHERE audit_id = ${scanId} AND kind = ${kind} ORDER BY created_at, id`
        : await sql<Row[]>`SELECT * FROM audit_artifacts WHERE audit_id = ${scanId} ORDER BY created_at, id`;
      return rows.map((r) => ({ id: r.id, scanId: r.audit_id, kind: r.kind, key: r.key, data: r.data, createdAt: new Date(r.created_at).toISOString() }));
    });
  }

  async insertPages(pages: PageRecord[]) {
    if (!pages.length) return;
    await this.q((sql) =>
      sql.begin(async (tx) => {
        for (const p of pages) {
          await tx`INSERT INTO audit_pages (id, audit_id, url, final_url, status_code, depth, fetched_at, canonical_url, title, data)
                   VALUES (${p.id}, ${p.scanId}, ${p.url}, ${p.finalUrl}, ${p.statusCode}, ${p.depth}, ${p.fetchedAt}, ${p.canonical ?? null}, ${p.title ? p.title.slice(0, 500) : null}, ${tx.json(j(p))}) ON CONFLICT (id) DO NOTHING`;
        }
      }),
    );
  }

  async listPages(scanId: string) {
    return this.q(async (sql) => (await sql<{ data: PageRecord }[]>`SELECT data FROM audit_pages WHERE audit_id = ${scanId} ORDER BY fetched_at, id`).map((r) => r.data));
  }

  async insertLinkChecks(links: LinkCheckRecord[]) {
    if (!links.length) return;
    await this.q((sql) =>
      sql.begin(async (tx) => {
        for (const l of links) {
          await tx`INSERT INTO audit_links (id, audit_id, url, kind, is_internal, category, verification, status_code, checked_at, source_url, final_url, redirect_count, data)
                   VALUES (${l.id}, ${l.scanId}, ${l.url}, ${l.kind}, ${l.internal}, ${l.category}, ${l.verification}, ${l.statusCode}, ${l.checkedAt},
                           ${l.sources[0] ?? null}, ${l.finalUrl}, ${l.redirectChain?.length ?? 0}, ${tx.json(j(l))}) ON CONFLICT (id) DO NOTHING`;
        }
      }),
    );
  }

  async listLinkChecks(scanId: string) {
    return this.q(async (sql) => (await sql<{ data: LinkCheckRecord }[]>`SELECT data FROM audit_links WHERE audit_id = ${scanId} ORDER BY checked_at, id`).map((r) => r.data));
  }

  async insertFindings(findings: Finding[]) {
    if (!findings.length) return;
    await this.q((sql) =>
      sql.begin(async (tx) => {
        for (const f of findings) {
          const { resolution: _r, ...data } = f;
          void _r;
          await tx`INSERT INTO audit_issues (id, audit_id, rule_id, category, severity, page_url, title, description, recommendation, evidence, created_at, data)
                   VALUES (${f.id}, ${f.scanId}, ${f.ruleId}, ${f.category}, ${f.severity}, ${f.affectedUrl}, ${f.title}, ${f.description}, ${f.recommendation}, ${tx.json(j(f.evidence))}, ${f.createdAt}, ${tx.json(j(data))})
                   ON CONFLICT (id) DO NOTHING`;
        }
      }),
    );
  }

  private rowToFinding(r: { data: Finding; resolution_status: ResolutionStatus; resolved_at: Date | null; resolution_note: string | null }): Finding {
    return { ...r.data, resolution: { status: r.resolution_status, resolvedAt: iso(r.resolved_at), note: r.resolution_note } };
  }

  async listFindings(scanId: string) {
    return this.q(async (sql) => (await sql<{ data: Finding; resolution_status: ResolutionStatus; resolved_at: Date | null; resolution_note: string | null }[]>`SELECT data, resolution_status, resolved_at, resolution_note FROM audit_issues WHERE audit_id = ${scanId}`).map((r) => this.rowToFinding(r)));
  }

  async getFinding(scanId: string, findingId: string) {
    return this.q(async (sql) => {
      const r = (await sql<{ data: Finding; resolution_status: ResolutionStatus; resolved_at: Date | null; resolution_note: string | null }[]>`SELECT data, resolution_status, resolved_at, resolution_note FROM audit_issues WHERE audit_id = ${scanId} AND id = ${findingId}`)[0];
      return r ? this.rowToFinding(r) : null;
    });
  }

  async saveAiRecommendation(rec: AiRecommendationRecord) {
    await this.q((sql) => sql`
      INSERT INTO ai_recommendations (id, audit_id, finding_key, provider, model, fallback_from, content, created_at)
      VALUES (${rec.id}, ${rec.scanId}, ${rec.findingId ?? "__summary__"}, ${rec.provider}, ${rec.model}, ${rec.fallbackFrom}, ${sql.json(j(rec.content))}, ${rec.createdAt})
      ON CONFLICT (audit_id, finding_key) DO UPDATE SET id = EXCLUDED.id, provider = EXCLUDED.provider, model = EXCLUDED.model,
        fallback_from = EXCLUDED.fallback_from, content = EXCLUDED.content, created_at = EXCLUDED.created_at`);
  }

  private rowToAi(r: { id: string; audit_id: string; finding_key: string; provider: ProviderId; model: string; fallback_from: ProviderId | null; content: unknown; created_at: Date }): AiRecommendationRecord {
    return { id: r.id, scanId: r.audit_id, findingId: r.finding_key === "__summary__" ? null : r.finding_key, provider: r.provider, model: r.model, fallbackFrom: r.fallback_from, content: r.content, createdAt: iso(r.created_at)! };
  }

  async getAiRecommendation(scanId: string, findingId: string | null) {
    return this.q(async (sql) => {
      const rows = await sql`SELECT * FROM ai_recommendations WHERE audit_id = ${scanId} AND finding_key = ${findingId ?? "__summary__"}`;
      return rows[0] ? this.rowToAi(rows[0] as never) : null;
    });
  }

  async listAiRecommendations(scanId: string) {
    return this.q(async (sql) => (await sql`SELECT * FROM ai_recommendations WHERE audit_id = ${scanId}`).map((r) => this.rowToAi(r as never)));
  }

  async countUsage(kind: UsageKind, principalId: string, ipHash: string, since: Date): Promise<UsageCount> {
    return this.q((sql) => this.countWith(sql, kind, principalId, ipHash, since));
  }

  private async countWith(sql: Sql | postgres.TransactionSql, kind: UsageKind, principalId: string, ipHash: string, since: Date): Promise<UsageCount> {
    const [p] = await sql<{ n: number; oldest: Date | null }[]>`SELECT count(*)::int AS n, min(created_at) AS oldest FROM usage_records WHERE kind = ${kind} AND principal_id = ${principalId} AND created_at >= ${since}`;
    const [i] = await sql<{ n: number; oldest: Date | null }[]>`SELECT count(*)::int AS n, min(created_at) AS oldest FROM usage_records WHERE kind = ${kind} AND ip_hash = ${ipHash} AND created_at >= ${since}`;
    return { byPrincipal: p.n, byIp: i.n, oldestPrincipal: p.oldest ? new Date(p.oldest) : null, oldestIp: i.oldest ? new Date(i.oldest) : null };
  }

  async consumeUsage(input: UsageConsumeInput): Promise<UsageConsumeResult> {
    return this.q(async (sql) => {
      const res = await sql.begin(async (tx) => {
        // Consistent lock order (IP, then principal) serialises concurrent checks without deadlocks.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`usage:${input.kind}:ip:${input.ipHash}`}))`;
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`usage:${input.kind}:p:${input.principalId}`}))`;
        const c = await this.countWith(tx, input.kind, input.principalId, input.ipHash, input.since);
        let allowed = c.byPrincipal < input.principalLimit && c.byIp < input.ipLimit;
        let burstLimited = false;
        if (allowed && input.burst) {
          const [b] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM usage_records WHERE kind = ${input.kind} AND principal_id = ${input.principalId} AND created_at >= ${input.burst.since}`;
          if (b.n >= input.burst.limit) {
            allowed = false;
            burstLimited = true;
          }
        }
        if (allowed) await tx`INSERT INTO usage_records (principal_id, ip_hash, kind) VALUES (${input.principalId}, ${input.ipHash}, ${input.kind})`;
        return { ...c, allowed, burstLimited };
      });
      return res as UsageConsumeResult;
    });
  }

  async refundUsage(kind: UsageKind, principalId: string, ipHash: string) {
    // Same advisory locks (and order) as consumeUsage: concurrent refunds are
    // serialised, so each one removes a different record and none is lost.
    await this.q((sql) =>
      sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`usage:${kind}:ip:${ipHash}`}))`;
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`usage:${kind}:p:${principalId}`}))`;
        await tx`DELETE FROM usage_records WHERE id = (SELECT id FROM usage_records WHERE kind = ${kind} AND principal_id = ${principalId} AND ip_hash = ${ipHash} ORDER BY created_at DESC, id DESC LIMIT 1)`;
      }),
    );
  }

  async getProviderPreference(principalId: string) {
    return this.q(async (sql) => ((await sql<{ ai_provider: ProviderId | null }[]>`SELECT ai_provider FROM user_settings WHERE principal_id = ${principalId}`)[0]?.ai_provider ?? null));
  }

  async setProviderPreference(principalId: string, provider: ProviderId | null) {
    await this.q((sql) => sql`INSERT INTO user_settings (principal_id, ai_provider) VALUES (${principalId}, ${provider}) ON CONFLICT (principal_id) DO UPDATE SET ai_provider = EXCLUDED.ai_provider, updated_at = now()`);
  }

  // ── Audit management ──────────────────────────────────────────────────────

  async updateScanMeta(
    id: string,
    patch: { title?: string | null; organizationId?: string | null },
    access: { principalId: string; organizationMemberUserId?: string; expectedOrganizationId?: string | null },
  ) {
    if (patch.organizationId !== undefined && access.expectedOrganizationId === undefined) return false;
    const targetOrganizationId = patch.organizationId ?? null;
    const targetMemberId = targetOrganizationId ? access.organizationMemberUserId : null;
    if (targetOrganizationId && !targetMemberId) return false;
    return this.q(async (sql) => {
      const expectedShare = patch.organizationId !== undefined
        ? sql`AND organization_id IS NOT DISTINCT FROM ${access.expectedOrganizationId ?? null}::uuid`
        : sql``;
      const currentMembership = targetMemberId
        ? sql`AND EXISTS (
            SELECT 1 FROM organization_members m
            WHERE m.organization_id = ${targetOrganizationId}::uuid
              AND m.user_id = ${targetMemberId}::uuid
          )`
        : sql``;
      const rows = await sql`
        UPDATE audits SET
          title = CASE WHEN ${patch.title !== undefined} THEN ${patch.title ?? null} ELSE title END,
          organization_id = CASE WHEN ${patch.organizationId !== undefined} THEN ${patch.organizationId ?? null}::uuid ELSE organization_id END
        WHERE id = ${id}
          AND principal_id = ${access.principalId}
          ${expectedShare}
          ${currentMembership}
        RETURNING id`;
      return rows.length > 0;
    });
  }

  async deleteScan(id: string) {
    return this.q(async (sql) => (await sql`DELETE FROM audits WHERE id = ${id} RETURNING id`).length > 0);
  }

  async listAudits(q: AuditQuery) {
    return this.q(async (sql) => {
      const orgs = q.organizationIds?.length ? q.organizationIds : null;
      const owner = orgs ? sql`(principal_id = ${q.principalId} OR organization_id = ANY(${orgs}::uuid[]))` : sql`principal_id = ${q.principalId}`;
      const term = q.search?.trim() ? `%${likeEscape(q.search.trim().slice(0, 100))}%` : null;
      const search = term ? sql`AND (coalesce(title, '') ILIKE ${term} OR hostname ILIKE ${term} OR target_url ILIKE ${term})` : sql``;
      const status =
        q.status === "active" ? sql`AND status IN ('queued','running')`
        : q.status === "completed" ? sql`AND status IN ('completed','completed_with_warnings')`
        : q.status === "failed" ? sql`AND status = 'failed'`
        : q.status === "cancelled" ? sql`AND status = 'cancelled'`
        : sql``;
      const order =
        q.sort === "oldest" ? sql`created_at ASC, id`
        : q.sort === "score_desc" ? sql`overall_score DESC NULLS LAST, created_at DESC, id`
        : q.sort === "score_asc" ? sql`overall_score ASC NULLS LAST, created_at DESC, id`
        : q.sort === "name" ? sql`lower(coalesce(title, hostname)) ASC, created_at DESC, id`
        : sql`created_at DESC, id`;
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audits WHERE ${owner} ${search} ${status}`;
      const rows = await sql<Omit<ScanRow, "state">[]>`SELECT ${sql.unsafe(LIST_COLUMNS)} FROM audits WHERE ${owner} ${search} ${status} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
      return { items: rows.map(rowToListItem), total: n };
    });
  }

  async auditStats(principalId: string, activeSince: Date): Promise<AuditStats> {
    return this.q(async (sql) => {
      const [c] = await sql<{ total: number; completed: number; running: number; failed: number; cancelled: number; sites: number }[]>`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status IN ('completed','completed_with_warnings'))::int AS completed,
               count(*) FILTER (WHERE status IN ('queued','running') AND updated_at >= ${activeSince})::int AS running,
               count(*) FILTER (WHERE status = 'failed')::int AS failed,
               count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
               count(DISTINCT hostname)::int AS sites
        FROM audits WHERE principal_id = ${principalId}`;
      const latest = sql`
        SELECT DISTINCT ON (hostname) id, overall_score FROM audits
        WHERE principal_id = ${principalId} AND status IN ('completed','completed_with_warnings')
        ORDER BY hostname, created_at DESC`;
      const [avg] = await sql<{ avg: number | null; n: number }[]>`SELECT round(avg(overall_score))::int AS avg, count(overall_score)::int AS n FROM (${latest}) l`;
      const sev = await sql<{ severity: string; n: number }[]>`
        SELECT i.severity, count(*)::int AS n FROM audit_issues i JOIN (${latest}) l ON l.id = i.audit_id
        WHERE i.resolution_status = 'open' GROUP BY i.severity`;
      const severity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
      for (const r of sev) if (r.severity in severity) severity[r.severity as keyof typeof severity] = r.n;
      return { ...c, averageScore: avg.n > 0 ? avg.avg : null, scoredSites: avg.n, severity };
    });
  }

  async latestIssues(principalId: string, limit: number): Promise<LatestIssue[]> {
    return this.q(async (sql) => {
      const rows = await sql<{ audit_id: string; title: string | null; hostname: string; data: Finding; created_at: Date }[]>`
        WITH latest AS (
          SELECT DISTINCT ON (hostname) id, title, hostname, created_at FROM audits
          WHERE principal_id = ${principalId} AND status IN ('completed','completed_with_warnings')
          ORDER BY hostname, created_at DESC
        )
        SELECT i.audit_id, l.title, l.hostname, i.data, l.created_at FROM audit_issues i JOIN latest l ON l.id = i.audit_id
        WHERE i.resolution_status = 'open' AND i.severity <> 'info'
        ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, l.created_at DESC, i.id
        LIMIT ${limit}`;
      return rows.map((r) => ({
        scanId: r.audit_id,
        scanTitle: r.title,
        hostname: r.hostname,
        finding: { id: r.data.id, ruleId: r.data.ruleId, title: r.data.title, severity: r.data.severity, category: r.data.category, affectedUrl: r.data.affectedUrl, affectedCount: r.data.affectedCount },
        createdAt: iso(r.created_at)!,
      }));
    });
  }

  private rowToHistory(r: { id: string; audit_id: string; hostname: string | null; title: string | null; event: HistoryEvent["event"]; from_status: string | null; to_status: string | null; detail: Record<string, unknown>; created_at: Date }): HistoryEvent {
    return { id: String(r.id), scanId: r.audit_id, hostname: r.hostname, scanTitle: r.title, event: r.event, fromStatus: r.from_status, toStatus: r.to_status, detail: r.detail ?? {}, createdAt: iso(r.created_at)! };
  }

  async recentActivity(principalId: string, limit: number) {
    return this.q(async (sql) =>
      (await sql`SELECT h.*, a.hostname, a.title FROM audit_history h JOIN audits a ON a.id = h.audit_id WHERE a.principal_id = ${principalId} ORDER BY h.created_at DESC, h.id DESC LIMIT ${limit}`).map((r) => this.rowToHistory(r as never)),
    );
  }

  async listHistory(scanId: string) {
    return this.q(async (sql) => (await sql`SELECT h.*, a.hostname, a.title FROM audit_history h JOIN audits a ON a.id = h.audit_id WHERE h.audit_id = ${scanId} ORDER BY h.created_at, h.id`).map((r) => this.rowToHistory(r as never)));
  }

  async setIssueResolution(scanId: string, findingId: string, status: ResolutionStatus, note: string | null) {
    return this.q(async (sql) => {
      const updated = await sql.begin(async (tx) => {
        const rows = await tx<{ data: Finding; resolution_status: ResolutionStatus; resolved_at: Date | null; resolution_note: string | null; before: ResolutionStatus }[]>`
          UPDATE audit_issues i SET resolution_status = ${status}, resolution_note = ${note},
            resolved_at = CASE WHEN ${status} = 'open' THEN NULL WHEN i.resolution_status = ${status} THEN i.resolved_at ELSE now() END
          FROM (SELECT id, resolution_status AS before FROM audit_issues WHERE audit_id = ${scanId} AND id = ${findingId} FOR UPDATE) old
          WHERE i.audit_id = ${scanId} AND i.id = old.id
          RETURNING i.data, i.resolution_status, i.resolved_at, i.resolution_note, old.before`;
        if (rows[0] && rows[0].before !== status) {
          await tx`INSERT INTO audit_history (audit_id, event, from_status, to_status, detail) VALUES (${scanId}, 'issue_status_changed', ${rows[0].before}, ${status}, ${tx.json({ finding_id: findingId, rule_id: rows[0].data.ruleId })})`;
        }
        return rows[0] ?? null;
      });
      return updated ? this.rowToFinding(updated as never) : null;
    });
  }

  async saveMetrics(scanId: string, metrics: AuditMetric[]) {
    if (!metrics.length) return;
    await this.q((sql) =>
      sql.begin(async (tx) => {
        for (const m of metrics) {
          await tx`INSERT INTO audit_metrics (audit_id, key, metric, category, value, unit, source, context)
                   VALUES (${scanId}, ${m.key}, ${m.metric}, ${m.category}, ${m.value}, ${m.unit}, ${m.source}, ${tx.json(j(m.context))})
                   ON CONFLICT (audit_id, key) DO UPDATE SET metric = EXCLUDED.metric, category = EXCLUDED.category, value = EXCLUDED.value, unit = EXCLUDED.unit, source = EXCLUDED.source, context = EXCLUDED.context`;
        }
      }),
    );
  }

  async listMetrics(scanId: string) {
    return this.q(async (sql) =>
      (await sql<{ key: string; metric: string; category: string; value: number | null; unit: AuditMetric["unit"]; source: AuditMetric["source"]; context: AuditMetric["context"] }[]>`SELECT key, metric, category, value, unit, source, context FROM audit_metrics WHERE audit_id = ${scanId} ORDER BY key`).map((r) => ({ ...r })),
    );
  }

  async reassignPrincipal(from: string, to: string) {
    if (from === to) return 0;
    return this.q((sql) =>
      sql.begin(async (tx) => {
        const moved = await tx`UPDATE audits SET principal_id = ${to} WHERE principal_id = ${from} RETURNING id`;
        await tx`UPDATE usage_records SET principal_id = ${to} WHERE principal_id = ${from}`;
        await tx`INSERT INTO user_settings (principal_id, ai_provider)
                 SELECT ${to}, ai_provider FROM user_settings WHERE principal_id = ${from} AND ai_provider IS NOT NULL
                 ON CONFLICT (principal_id) DO UPDATE SET ai_provider = COALESCE(user_settings.ai_provider, EXCLUDED.ai_provider)`;
        await tx`DELETE FROM user_settings WHERE principal_id = ${from}`;
        return moved.length;
      }),
    ) as Promise<number>;
  }

  async countScans(principalId: string) {
    return this.q(async (sql) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audits WHERE principal_id = ${principalId}`)[0].n);
  }

  async listRunnableScans(limit: number, maxAgeMs: number): Promise<RunnableScan[]> {
    return this.q(async (sql) =>
      (await sql<{ id: string; principal_id: string; ip_hash: string | null }[]>`
        SELECT id, principal_id, ip_hash FROM audits
        WHERE status IN ${sql(ACTIVE_STATUSES)} AND (lease_until IS NULL OR lease_until < now())
          AND created_at >= now() - (${maxAgeMs} * interval '1 millisecond')
        ORDER BY updated_at ASC LIMIT ${limit}`).map((r) => ({ id: r.id, principalId: r.principal_id, ipHash: r.ip_hash })),
    );
  }

  async deletePrincipalData(principalId: string) {
    await this.q((sql) =>
      sql.begin(async (tx) => {
        await tx`DELETE FROM usage_records WHERE principal_id = ${principalId}`;
        await tx`DELETE FROM principals WHERE id = ${principalId}`; // cascades audits, settings
      }),
    );
  }

  // ── Accounts ──────────────────────────────────────────────────────────────

  async ensureProfile(u: { id: string; email: string | null; displayName: string | null }) {
    return this.q((sql) =>
      sql.begin(async (tx) => {
        const [p] = await tx<ProfileRow[]>`
          INSERT INTO profiles (id, email, display_name) VALUES (${u.id}, ${u.email}, ${u.displayName?.slice(0, 80) ?? null})
          ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email,
            display_name = COALESCE(profiles.display_name, EXCLUDED.display_name),
            updated_at = CASE WHEN profiles.email IS DISTINCT FROM EXCLUDED.email THEN now() ELSE profiles.updated_at END
          RETURNING id, email, display_name, created_at, updated_at`;
        await tx`INSERT INTO principals (id, kind, user_id) VALUES (${`user:${u.id}`}, 'user', ${u.id})
                 ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), kind = 'user', user_id = EXCLUDED.user_id`;
        return rowToProfile(p);
      }),
    ) as Promise<Profile>;
  }

  async getProfile(userId: string) {
    return this.q(async (sql) => {
      const [r] = await sql<ProfileRow[]>`SELECT id, email, display_name, created_at, updated_at FROM profiles WHERE id = ${userId}`;
      return r ? rowToProfile(r) : null;
    });
  }

  async updateProfile(userId: string, patch: { displayName?: string | null }) {
    return this.q(async (sql) => {
      const [r] = await sql<ProfileRow[]>`
        UPDATE profiles SET
          display_name = CASE WHEN ${patch.displayName !== undefined} THEN ${patch.displayName ?? null} ELSE display_name END,
          updated_at = now()
        WHERE id = ${userId} RETURNING id, email, display_name, created_at, updated_at`;
      return r ? rowToProfile(r) : null;
    });
  }

  async getProfessionalData(userId: string): Promise<ProfessionalData> {
    return this.q(async (sql) => {
      const [[profile], services, portfolio] = await Promise.all([
        sql<ProfessionalProfileRow[]>`SELECT * FROM professional_profiles WHERE user_id = ${userId}`,
        sql<ProfessionalServiceRow[]>`SELECT id, title, description, categories, keywords, is_public, sort_order FROM professional_services WHERE user_id = ${userId} ORDER BY sort_order, id`,
        sql<ProfessionalPortfolioRow[]>`SELECT id, title, project_url, description, service_ids, categories, is_public, sort_order FROM professional_portfolio_items WHERE user_id = ${userId} ORDER BY sort_order, id`,
      ]);
      return rowToProfessionalData(profile, services, portfolio);
    });
  }

  async saveProfessionalData(userId: string, data: ProfessionalDataInput): Promise<ProfessionalData> {
    await this.q((sql) => sql.begin(async (tx) => {
      await tx`
        INSERT INTO professional_profiles (user_id, profile_type, professional_name, business_name, job_title, headline, biography, website_url, contact_email, contact_phone, location, public_fields, brand_colors, logo_data_url, onboarding_completed)
        VALUES (${userId}, ${data.profile.profileType}, ${data.profile.professionalName}, ${data.profile.businessName}, ${data.profile.jobTitle}, ${data.profile.headline}, ${data.profile.biography}, ${data.profile.websiteUrl}, ${data.profile.contactEmail}, ${data.profile.contactPhone}, ${data.profile.location}, ${tx.json(data.profile.publicFields as unknown as Json)}, ${tx.json(data.profile.brandColors as unknown as Json)}, ${data.profile.logoDataUrl}, ${data.profile.onboardingCompleted})
        ON CONFLICT (user_id) DO UPDATE SET
          profile_type = EXCLUDED.profile_type, professional_name = EXCLUDED.professional_name, business_name = EXCLUDED.business_name,
          job_title = EXCLUDED.job_title, headline = EXCLUDED.headline, biography = EXCLUDED.biography, website_url = EXCLUDED.website_url,
          contact_email = EXCLUDED.contact_email, contact_phone = EXCLUDED.contact_phone, location = EXCLUDED.location,
          public_fields = EXCLUDED.public_fields, brand_colors = EXCLUDED.brand_colors, logo_data_url = EXCLUDED.logo_data_url,
          onboarding_completed = EXCLUDED.onboarding_completed, updated_at = now()`;
      await tx`DELETE FROM professional_services WHERE user_id = ${userId}`;
      const serviceRows = data.services.map((service, sortOrder) => ({
        id: service.id,
        user_id: userId,
        title: service.title,
        description: service.description,
        categories: tx.json(service.categories as unknown as Json),
        keywords: tx.json(service.keywords as unknown as Json),
        is_public: service.isPublic,
        sort_order: sortOrder,
      }));
      if (serviceRows.length) {
        await tx`INSERT INTO professional_services ${tx(serviceRows, ["id", "user_id", "title", "description", "categories", "keywords", "is_public", "sort_order"])}`;
      }
      await tx`DELETE FROM professional_portfolio_items WHERE user_id = ${userId}`;
      const portfolioRows = data.portfolio.map((item, sortOrder) => ({
        id: item.id,
        user_id: userId,
        title: item.title,
        project_url: item.projectUrl,
        description: item.description,
        service_ids: tx.json(item.serviceIds as unknown as Json),
        categories: tx.json(item.categories as unknown as Json),
        is_public: item.isPublic,
        sort_order: sortOrder,
      }));
      if (portfolioRows.length) {
        await tx`INSERT INTO professional_portfolio_items ${tx(portfolioRows, ["id", "user_id", "title", "project_url", "description", "service_ids", "categories", "is_public", "sort_order"])}`;
      }
    }));
    return this.getProfessionalData(userId);
  }

  async getUserSettings(principalId: string): Promise<UserSettings> {
    return this.q(async (sql) => {
      const [r] = await sql<{ theme: UserSettings["theme"]; default_browser: boolean; default_performance: boolean; updated_at: Date }[]>`SELECT theme, default_browser, default_performance, updated_at FROM user_settings WHERE principal_id = ${principalId}`;
      return r ? { theme: r.theme, defaultBrowser: r.default_browser, defaultPerformance: r.default_performance, updatedAt: iso(r.updated_at) } : { theme: "system", defaultBrowser: true, defaultPerformance: true, updatedAt: null };
    });
  }

  async updateUserSettings(principalId: string, patch: Partial<Omit<UserSettings, "updatedAt">>) {
    await this.q((sql) => sql`
      INSERT INTO user_settings (principal_id, theme, default_browser, default_performance)
      VALUES (${principalId}, ${patch.theme ?? "system"}, ${patch.defaultBrowser ?? true}, ${patch.defaultPerformance ?? true})
      ON CONFLICT (principal_id) DO UPDATE SET
        theme = CASE WHEN ${patch.theme !== undefined} THEN EXCLUDED.theme ELSE user_settings.theme END,
        default_browser = CASE WHEN ${patch.defaultBrowser !== undefined} THEN EXCLUDED.default_browser ELSE user_settings.default_browser END,
        default_performance = CASE WHEN ${patch.defaultPerformance !== undefined} THEN EXCLUDED.default_performance ELSE user_settings.default_performance END,
        updated_at = now()`);
    return this.getUserSettings(principalId);
  }

  async getActiveSubscription(userId: string): Promise<SubscriptionInfo | null> {
    return this.q(async (sql) => {
      // A paid plan requires a live status AND a verified, unexpired period end.
      const [r] = await sql`
        SELECT * FROM subscriptions
        WHERE user_id = ${userId} AND status IN ('trialing','active','past_due') AND current_period_end IS NOT NULL AND current_period_end > now()
        ORDER BY created_at DESC LIMIT 1`;
      return r ? rowToSubscriptionInfo(r) : null;
    });
  }

  async getRecentlyEndedSubscription(userId: string, since: Date): Promise<SubscriptionInfo | null> {
    return this.q(async (sql) => {
      const [r] = await sql`
        SELECT * FROM subscriptions
        WHERE user_id = ${userId} AND plan_id <> 'free'
          AND (ended_at IS NOT NULL OR current_period_end <= now())
          AND coalesce(ended_at, current_period_end) > ${since}
        ORDER BY coalesce(ended_at, current_period_end) DESC LIMIT 1`;
      return r ? rowToSubscriptionInfo(r) : null;
    });
  }

  async applyBillingEvent(ev: NormalizedBillingEvent): Promise<ApplyBillingResult> {
    return this.q((sql) =>
      sql.begin(async (tx) => {
        const eventRowId = randomUUID();
        const known = (await tx`SELECT 1 FROM profiles WHERE id = ${ev.userId}`).length > 0;
        const inserted = await tx`
          INSERT INTO billing_events (id, provider, event_id, event_type, user_id, occurred_at, outcome)
          VALUES (${eventRowId}, ${ev.provider}, ${ev.eventId}, ${ev.type}, ${known ? ev.userId : null}, ${ev.occurredAt}, 'processing')
          ON CONFLICT (provider, event_id) DO UPDATE SET outcome = 'processing', received_at = now(), user_id = EXCLUDED.user_id
            -- Retries of events that could not be matched yet (account created later, renewal before activation) are re-evaluated.
            WHERE billing_events.outcome IN ('rejected_unknown_user', 'ignored_unknown_subscription')
          RETURNING id`;
        if (!inserted.length) return { outcome: "duplicate", subscription: null } as ApplyBillingResult;
        const rowId = inserted[0].id as string;
        const finish = async (res: ApplyBillingResult, subscriptionId: string | null) => {
          await tx`UPDATE billing_events SET outcome = ${res.outcome}, subscription_id = ${subscriptionId}, detail = ${tx.json({ message: res.message ?? null })} WHERE id = ${rowId}`;
          return res;
        };
        if (!known) return finish({ outcome: "rejected_unknown_user", subscription: null, message: "No SiteInsights account matches the event." }, null);
        const [row] = await tx`SELECT * FROM subscriptions WHERE provider = ${ev.provider} AND provider_reference = ${ev.subscriptionRef} FOR UPDATE`;
        const current = row ? rowToStoredSubscription(row) : null;
        const res = reduceSubscription(current, ev);
        if (res.outcome !== "applied" || !res.next) return finish({ outcome: res.outcome, subscription: res.subscription, message: res.message }, current?.id ?? null);
        const n = res.next;
        if (grantsPaidAccess(n)) {
          // One live subscription per account: a new paid subscription supersedes any other live one.
          await tx`UPDATE subscriptions SET status = 'canceled', ended_at = now(), current_period_end = LEAST(coalesce(current_period_end, now()), now()), updated_at = now()
                   WHERE user_id = ${n.userId} AND id <> ${n.id} AND status IN ('trialing','active','past_due')`;
        }
        await tx`
          INSERT INTO subscriptions (id, user_id, plan_id, status, provider, provider_reference, current_period_start, current_period_end, cancel_at, cancel_at_period_end, ended_at, last_event_at)
          VALUES (${n.id}, ${n.userId}, ${n.planId}, ${n.status}, ${n.provider}, ${n.providerReference}, ${n.currentPeriodStart}, ${n.currentPeriodEnd}, ${n.cancelAt}, ${n.cancelAtPeriodEnd}, ${n.endedAt}, ${n.lastEventAt})
          ON CONFLICT (id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = EXCLUDED.status, current_period_start = EXCLUDED.current_period_start,
            current_period_end = EXCLUDED.current_period_end, cancel_at = EXCLUDED.cancel_at, cancel_at_period_end = EXCLUDED.cancel_at_period_end,
            ended_at = EXCLUDED.ended_at, last_event_at = EXCLUDED.last_event_at, updated_at = now()`;
        return finish({ outcome: "applied", subscription: n }, n.id);
      }) as Promise<ApplyBillingResult>,
    );
  }

  async getPlan(planId: string): Promise<PlanRow | null> {
    return this.q(async (sql) => (await sql<PlanRow[]>`SELECT id, name, description, limits FROM plans WHERE id = ${planId}`)[0] ?? null);
  }

  private async recordOrganizationActivity(sql: Sql | postgres.TransactionSql, input: { organizationId: string; actorUserId: string | null; event: string; subjectUserId?: string | null; prospectId?: string | null; details?: Record<string, unknown> }) {
    await sql`INSERT INTO organization_activity (organization_id, actor_user_id, event_type, subject_user_id, prospect_id, details)
      VALUES (${input.organizationId}, ${input.actorUserId}, ${input.event}, ${input.subjectUserId ?? null}, ${input.prospectId ?? null}, ${sql.json((input.details ?? {}) as postgres.JSONValue)})`;
  }

  async createOrganization(userId: string, name: string): Promise<Organization | null> {
    return this.q((sql) => sql.begin(async (tx) => {
      const [profile] = await tx<{ id: string }[]>`SELECT id FROM profiles WHERE id = ${userId} FOR UPDATE`;
      if (!profile) return null;
      const [owned] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM organization_members WHERE user_id = ${userId} AND role = 'owner'`;
      if (owned.n >= MAX_OWNED_ORGANIZATIONS_PER_USER) return null;
      const [o] = await tx<{ id: string; name: string; created_at: Date }[]>`INSERT INTO organizations (id, name, created_by) VALUES (${randomUUID()}, ${name}, ${userId}) RETURNING id, name, created_at`;
      await tx`INSERT INTO organization_members (organization_id, user_id, role) VALUES (${o.id}, ${userId}, 'owner')`;
      await this.recordOrganizationActivity(tx, { organizationId: o.id, actorUserId: userId, event: "organization_created" });
      return { id: o.id, name: o.name, createdAt: iso(o.created_at)! };
    }));
  }

  async listOrganizations(userId: string): Promise<OrganizationSummary[]> {
    return this.q(async (sql) =>
      (await sql<{ id: string; name: string; created_at: Date; role: OrgRole; member_count: number }[]>`
        SELECT o.id, o.name, o.created_at, m.role, (SELECT count(*)::int FROM organization_members x WHERE x.organization_id = o.id) AS member_count
        FROM organizations o JOIN organization_members m ON m.organization_id = o.id AND m.user_id = ${userId} ORDER BY o.name`).map((r) => ({ id: r.id, name: r.name, createdAt: iso(r.created_at)!, role: r.role, memberCount: r.member_count })),
    );
  }

  async getMembership(orgId: string, userId: string) {
    return this.q(async (sql) => (await sql<{ role: OrgRole }[]>`SELECT role FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${userId}`)[0]?.role ?? null);
  }

  async memberOrganizationIds(userId: string) {
    return this.q(async (sql) => (await sql<{ id: string }[]>`SELECT organization_id AS id FROM organization_members WHERE user_id = ${userId}`).map((r) => r.id));
  }

  async listMembers(orgId: string): Promise<OrganizationMember[]> {
    return this.q(async (sql) =>
      (await sql<{ user_id: string; email: string | null; display_name: string | null; role: OrgRole; created_at: Date }[]>`
        SELECT m.user_id, p.email, p.display_name, m.role, m.created_at FROM organization_members m JOIN profiles p ON p.id = m.user_id
        WHERE m.organization_id = ${orgId} ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, p.email`).map((r) => ({ userId: r.user_id, email: r.email, displayName: r.display_name, role: r.role, joinedAt: iso(r.created_at)! })),
    );
  }

  async listMembersForUserOrganizations(userId: string): Promise<OrganizationMemberWithOrganization[]> {
    return this.q(async (sql) =>
      (await sql<{ organization_id: string; user_id: string; email: string | null; display_name: string | null; role: OrgRole; created_at: Date }[]>`
        SELECT m.organization_id, m.user_id, p.email, p.display_name, m.role, m.created_at
        FROM organization_members m JOIN profiles p ON p.id = m.user_id
        WHERE EXISTS (
          SELECT 1 FROM organization_members own
          WHERE own.organization_id = m.organization_id AND own.user_id = ${userId}
        )
        ORDER BY m.organization_id, CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, p.email`).map((r) => ({
          organizationId: r.organization_id,
          userId: r.user_id,
          email: r.email,
          displayName: r.display_name,
          role: r.role,
          joinedAt: iso(r.created_at)!,
        })),
    );
  }

  async updateMemberRole(orgId: string, userId: string, role: "admin" | "member", actorUserId: string) {
    return this.q((sql) => sql.begin(async (tx) => {
      const [org] = await tx<{ id: string }[]>`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
      if (!org) return "not_found" as const;
      const [actor] = await tx<{ role: OrgRole }[]>`SELECT role FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${actorUserId} FOR UPDATE`;
      if (actor?.role !== "owner") return "forbidden" as const;
      const [current] = await tx<{ role: OrgRole }[]>`SELECT role FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${userId} FOR UPDATE`;
      if (!current) return "not_found" as const;
      if (current.role === "owner") return "owner" as const;
      if (current.role !== role) {
        await tx`UPDATE organization_members SET role = ${role} WHERE organization_id = ${orgId} AND user_id = ${userId}`;
        await this.recordOrganizationActivity(tx, { organizationId: orgId, actorUserId, subjectUserId: userId, event: "member_role_changed", details: { fromRole: current.role, toRole: role } });
      }
      return "updated" as const;
    }));
  }

  async transferOwnership(orgId: string, fromUserId: string, toUserId: string, previousOwnerRole: "admin" | "member") {
    return this.q((sql) => sql.begin(async (tx) => {
      const [org] = await tx<{ id: string }[]>`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
      if (!org) return "not_owner" as const;
      const [from] = await tx<{ role: OrgRole }[]>`SELECT role FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${fromUserId} FOR UPDATE`;
      if (from?.role !== "owner") return "not_owner" as const;
      const [to] = await tx<{ role: OrgRole }[]>`SELECT role FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${toUserId} FOR UPDATE`;
      if (!to || to.role === "owner" || toUserId === fromUserId) return "member_not_found" as const;
      // Promote the recipient first so the team never has a zero-owner state, even inside the transaction.
      await tx`UPDATE organization_members SET role = 'owner' WHERE organization_id = ${orgId} AND user_id = ${toUserId}`;
      await tx`UPDATE organization_members SET role = ${previousOwnerRole} WHERE organization_id = ${orgId} AND user_id = ${fromUserId}`;
      await this.recordOrganizationActivity(tx, { organizationId: orgId, actorUserId: fromUserId, subjectUserId: toUserId, event: "ownership_transferred", details: { formerOwnerRole: previousOwnerRole } });
      return "transferred" as const;
    }));
  }

  async removeMember(orgId: string, userId: string, actorUserId: string) {
    return this.q((sql) => sql.begin(async (tx) => {
      const [org] = await tx<{ id: string }[]>`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
      if (!org) return "not_found" as const;
      const [actor] = await tx<{ role: OrgRole }[]>`SELECT role FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${actorUserId} FOR UPDATE`;
      if (!actor) return "forbidden" as const;
      const [target] = await tx<{ role: OrgRole }[]>`SELECT role FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${userId} FOR UPDATE`;
      if (!target) return "not_found" as const;
      if (actorUserId !== userId && (actor.role === "member" || ((target.role === "owner" || target.role === "admin") && actor.role !== "owner"))) return "forbidden" as const;
      if (target.role === "owner") {
        const [owners] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = ${orgId} AND role = 'owner'`;
        if (owners.n <= 1) return "last_owner" as const;
      }
      await tx`DELETE FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${userId}`;
      // A departing member's own audit and prospect shares end; other members'
      // prospects remain shared but are unassigned if they pointed to this user.
      await tx`UPDATE audits SET organization_id = NULL WHERE organization_id = ${orgId} AND owner_id = ${userId}`;
      await tx`UPDATE prospects SET organization_id = NULL, assigned_to_user_id = NULL, updated_at = now()
        WHERE organization_id = ${orgId} AND principal_id = ${`user:${userId}`}`;
      await tx`UPDATE prospects SET assigned_to_user_id = NULL, updated_at = now()
        WHERE organization_id = ${orgId} AND assigned_to_user_id = ${userId}`;
      await this.recordOrganizationActivity(tx, { organizationId: orgId, actorUserId, subjectUserId: userId, event: actorUserId === userId ? "member_left" : "member_removed" });
      return "removed" as const;
    }));
  }

  async countOwners(orgId: string) {
    return this.q(async (sql) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = ${orgId} AND role = 'owner'`)[0]?.n ?? 0);
  }

  async renameOrganization(orgId: string, name: string, actorUserId: string) {
    return this.q((sql) => sql.begin(async (tx) => {
      const [org] = await tx<{ id: string }[]>`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
      if (!org) return false;
      const [actor] = await tx<{ role: OrgRole }[]>`SELECT role FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${actorUserId} FOR UPDATE`;
      if (!actor || actor.role === "member") return false;
      await tx`UPDATE organizations SET name = ${name}, updated_at = now() WHERE id = ${orgId}`;
      await this.recordOrganizationActivity(tx, { organizationId: orgId, actorUserId, event: "organization_renamed", details: { name } });
      return true;
    }));
  }

  async deleteOrganization(orgId: string, actorUserId: string) {
    return this.q((sql) => sql.begin(async (tx) => {
      const [org] = await tx<{ id: string }[]>`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
      if (!org) return false;
      const [actor] = await tx<{ role: OrgRole }[]>`SELECT role FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${actorUserId} FOR UPDATE`;
      if (actor?.role !== "owner") return false;
      await tx`UPDATE prospects SET organization_id = NULL, assigned_to_user_id = NULL, updated_at = now() WHERE organization_id = ${orgId}`;
      await tx`DELETE FROM organizations WHERE id = ${orgId}`;
      return true;
    }));
  }

  async createInvitation(input: { id: string; organizationId: string; email: string; role: "admin" | "member"; tokenHash: string; invitedByUserId: string; expiresAt: Date; emailDeliveryStatus: OrganizationInvitationEmailStatus; emailErrorCode: string | null }) {
    return this.q((sql) => sql.begin(async (tx) => {
      const [org] = await tx<{ id: string }[]>`SELECT id FROM organizations WHERE id = ${input.organizationId} FOR UPDATE`;
      if (!org) return { invitation: null, outcome: "not_found" as const };
      const [actor] = await tx<{ role: OrgRole }[]>`SELECT role FROM organization_members WHERE organization_id = ${input.organizationId} AND user_id = ${input.invitedByUserId} FOR UPDATE`;
      if (!actor || actor.role === "member" || (input.role === "admin" && actor.role !== "owner")) return { invitation: null, outcome: "forbidden" as const };
      const [member] = await tx<{ user_id: string }[]>`SELECT m.user_id FROM organization_members m JOIN profiles p ON p.id = m.user_id
        WHERE m.organization_id = ${input.organizationId} AND lower(p.email) = ${input.email} LIMIT 1`;
      if (member) return { invitation: null, outcome: "member_exists" as const };
      const [existing] = await tx<{ id: string; active: boolean }[]>`SELECT id, expires_at > now() AS active
        FROM organization_invitations WHERE organization_id = ${input.organizationId} AND lower(invited_email) = ${input.email} AND status = 'pending' FOR UPDATE`;
      if (!existing?.active) {
        const [counts] = await tx<{ members: number; invitations: number }[]>`
          SELECT (SELECT count(*)::int FROM organization_members WHERE organization_id = ${input.organizationId}) AS members,
                 (SELECT count(*)::int FROM organization_invitations WHERE organization_id = ${input.organizationId} AND status = 'pending' AND expires_at > now()) AS invitations`;
        if (counts.members + counts.invitations >= MAX_ORGANIZATION_MEMBERS) return { invitation: null, outcome: "member_limit" as const };
      }
      const [row] = await tx<OrganizationInvitationRow[]>`INSERT INTO organization_invitations (id, organization_id, invited_email, role, token_hash, invited_by_user_id, status, expires_at, email_delivery_status, email_error_code)
        VALUES (${input.id}, ${input.organizationId}, ${input.email}, ${input.role}, ${input.tokenHash}, ${input.invitedByUserId}, 'pending', ${input.expiresAt}, ${input.emailDeliveryStatus}, ${input.emailErrorCode})
        ON CONFLICT (organization_id, lower(invited_email)) WHERE status = 'pending'
        DO UPDATE SET role = EXCLUDED.role, token_hash = EXCLUDED.token_hash, invited_by_user_id = EXCLUDED.invited_by_user_id, expires_at = EXCLUDED.expires_at,
          email_delivery_status = EXCLUDED.email_delivery_status, email_last_attempt_at = NULL, email_error_code = EXCLUDED.email_error_code,
          responded_at = NULL, accepted_by_user_id = NULL, accepted_at = NULL, updated_at = now()
        RETURNING id, organization_id, invited_email, role, status, created_at, expires_at, invited_by_user_id, accepted_at,
          email_delivery_status, email_last_attempt_at, email_error_code`;
      await this.recordOrganizationActivity(tx, { organizationId: input.organizationId, actorUserId: input.invitedByUserId, event: "invitation_sent", details: { role: row.role } });
      return { invitation: rowToOrganizationInvitation(row), outcome: existing ? "updated" as const : "created" as const };
    }));
  }

  async resendInvitation(input: { organizationId: string; invitationId: string; tokenHash: string; invitedByUserId: string; expiresAt: Date }) {
    return this.q((sql) => sql.begin(async (tx) => {
      const [org] = await tx<{ id: string }[]>`SELECT id FROM organizations WHERE id = ${input.organizationId} FOR UPDATE`;
      if (!org) return { invitation: null, outcome: "not_found" as const };
      const [actor] = await tx<{ role: OrgRole }[]>`SELECT role FROM organization_members WHERE organization_id = ${input.organizationId} AND user_id = ${input.invitedByUserId} FOR UPDATE`;
      if (!actor || actor.role === "member") return { invitation: null, outcome: "forbidden" as const };
      const [invite] = await tx<OrganizationInvitationRow[]>`SELECT id, organization_id, invited_email, role, status, created_at, expires_at, invited_by_user_id, accepted_at,
        email_delivery_status, email_last_attempt_at, email_error_code
        FROM organization_invitations WHERE organization_id = ${input.organizationId} AND id = ${input.invitationId} FOR UPDATE`;
      if (!invite) return { invitation: null, outcome: "not_found" as const };
      if (invite.role === "admin" && actor.role !== "owner") return { invitation: null, outcome: "forbidden" as const };
      if (invite.status !== "pending" && invite.status !== "expired") return { invitation: null, outcome: "not_pending" as const };
      const [member] = await tx<{ user_id: string }[]>`SELECT m.user_id FROM organization_members m JOIN profiles p ON p.id = m.user_id
        WHERE m.organization_id = ${input.organizationId} AND lower(p.email) = ${invite.invited_email} LIMIT 1`;
      if (member) return { invitation: null, outcome: "member_exists" as const };
      const [otherPending] = await tx<{ id: string }[]>`SELECT id FROM organization_invitations
        WHERE organization_id = ${input.organizationId} AND lower(invited_email) = ${invite.invited_email} AND status = 'pending' AND id <> ${input.invitationId} FOR UPDATE`;
      if (otherPending) return { invitation: null, outcome: "pending_exists" as const };
      const [expiration] = await tx<{ expired: boolean }[]>`SELECT (status = 'expired' OR expires_at <= now()) AS expired
        FROM organization_invitations WHERE organization_id = ${input.organizationId} AND id = ${input.invitationId}`;
      const wasExpired = expiration?.expired ?? true;
      if (wasExpired) {
        const [counts] = await tx<{ members: number; invitations: number }[]>`
          SELECT (SELECT count(*)::int FROM organization_members WHERE organization_id = ${input.organizationId}) AS members,
                 (SELECT count(*)::int FROM organization_invitations WHERE organization_id = ${input.organizationId} AND status = 'pending' AND expires_at > now()) AS invitations`;
        if (counts.members + counts.invitations >= MAX_ORGANIZATION_MEMBERS) return { invitation: null, outcome: "member_limit" as const };
      }
      const [row] = await tx<OrganizationInvitationRow[]>`UPDATE organization_invitations SET status = 'pending', token_hash = ${input.tokenHash},
        invited_by_user_id = ${input.invitedByUserId}, expires_at = ${input.expiresAt}, email_delivery_status = 'not_attempted',
        email_last_attempt_at = NULL, email_error_code = NULL, responded_at = NULL, accepted_by_user_id = NULL, accepted_at = NULL, updated_at = now()
        WHERE organization_id = ${input.organizationId} AND id = ${input.invitationId}
        RETURNING id, organization_id, invited_email, role, status, created_at, expires_at, invited_by_user_id, accepted_at,
          email_delivery_status, email_last_attempt_at, email_error_code`;
      await this.recordOrganizationActivity(tx, { organizationId: input.organizationId, actorUserId: input.invitedByUserId, event: "invitation_resent", details: { role: row.role } });
      return { invitation: rowToOrganizationInvitation(row), outcome: "resent" as const };
    }));
  }

  async updateInvitationEmailStatus(input: { organizationId: string; invitationId: string; actorUserId: string; status: OrganizationInvitationEmailStatus; errorCode: string | null }) {
    return this.q((sql) => sql.begin(async (tx) => {
      const [org] = await tx<{ id: string }[]>`SELECT id FROM organizations WHERE id = ${input.organizationId} FOR UPDATE`;
      if (!org) return null;
      const [actor] = await tx<{ role: OrgRole }[]>`SELECT role FROM organization_members WHERE organization_id = ${input.organizationId} AND user_id = ${input.actorUserId} FOR UPDATE`;
      if (!actor || actor.role === "member") return null;
      const [invite] = await tx<{ role: "admin" | "member" }[]>`SELECT role FROM organization_invitations
        WHERE organization_id = ${input.organizationId} AND id = ${input.invitationId} AND status = 'pending' FOR UPDATE`;
      if (!invite || (invite.role === "admin" && actor.role !== "owner")) return null;
      const [row] = await tx<OrganizationInvitationRow[]>`UPDATE organization_invitations SET email_delivery_status = ${input.status},
        email_last_attempt_at = CASE WHEN ${input.status} = 'not_configured' THEN NULL ELSE now() END,
        email_error_code = ${input.errorCode}, updated_at = now()
        WHERE organization_id = ${input.organizationId} AND id = ${input.invitationId} AND status = 'pending'
        RETURNING id, organization_id, invited_email, role, status, created_at, expires_at, invited_by_user_id, accepted_at,
          email_delivery_status, email_last_attempt_at, email_error_code`;
      return row ? rowToOrganizationInvitation(row) : null;
    }));
  }

  async listInvitations(orgId: string): Promise<OrganizationInvitation[]> {
    return this.q(async (sql) => (await sql<OrganizationInvitationRow[]>`SELECT id, organization_id, invited_email, role,
      CASE WHEN status = 'pending' AND expires_at <= now() THEN 'expired' ELSE status END AS status,
      created_at, expires_at, invited_by_user_id, accepted_at, email_delivery_status, email_last_attempt_at, email_error_code
      FROM organization_invitations WHERE organization_id = ${orgId} ORDER BY created_at DESC LIMIT 50`).map(rowToOrganizationInvitation));
  }

  async listRecipientInvitations(email: string): Promise<RecipientOrganizationInvitation[]> {
    return this.q(async (sql) => (await sql<(OrganizationInvitationRow & { organization_name: string; inviter_name: string | null; inviter_email: string | null })[]>`SELECT i.id, i.organization_id, i.invited_email, i.role, i.status,
      i.created_at, i.expires_at, i.invited_by_user_id, i.accepted_at, i.email_delivery_status, i.email_last_attempt_at, i.email_error_code,
      o.name AS organization_name, inviter.display_name AS inviter_name, inviter.email AS inviter_email
      FROM organization_invitations i JOIN organizations o ON o.id = i.organization_id
      LEFT JOIN profiles inviter ON inviter.id = i.invited_by_user_id
      WHERE lower(i.invited_email) = ${email} AND i.status = 'pending' AND i.expires_at > now()
      ORDER BY i.created_at DESC LIMIT 50`).map(rowToRecipientInvitation));
  }

  async getInvitationPreview(tokenHash: string): Promise<OrganizationInvitationPreview | null> {
    return this.q(async (sql) => {
      const [row] = await sql<(OrganizationInvitationRow & { organization_name: string; inviter_name: string | null; inviter_email: string | null })[]>`SELECT i.id, i.organization_id, i.invited_email, i.role,
        CASE WHEN i.status = 'pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status END AS status,
        i.created_at, i.expires_at, i.invited_by_user_id, i.accepted_at, i.email_delivery_status, i.email_last_attempt_at, i.email_error_code,
        o.name AS organization_name, inviter.display_name AS inviter_name, inviter.email AS inviter_email
        FROM organization_invitations i JOIN organizations o ON o.id = i.organization_id
        LEFT JOIN profiles inviter ON inviter.id = i.invited_by_user_id
        WHERE i.token_hash = ${tokenHash}`;
      return row ? rowToInvitationPreview(row) : null;
    });
  }

  private async respondToInvitation(selector: { kind: "token" | "id"; value: string }, action: "accept" | "reject", userId: string, email: string) {
    return this.q((sql) => sql.begin(async (tx) => {
      const [hint] = selector.kind === "token"
        ? await tx<{ organization_id: string }[]>`SELECT organization_id FROM organization_invitations WHERE token_hash = ${selector.value}`
        : await tx<{ organization_id: string }[]>`SELECT organization_id FROM organization_invitations WHERE id = ${selector.value}`;
      if (!hint) return "not_found" as const;
      const [org] = await tx<{ id: string }[]>`SELECT id FROM organizations WHERE id = ${hint.organization_id} FOR UPDATE`;
      if (!org) return "not_found" as const;
      const [invite] = selector.kind === "token"
        ? await tx<OrganizationInvitationRow[]>`SELECT id, organization_id, invited_email, role, status, created_at, expires_at, invited_by_user_id, accepted_at,
            email_delivery_status, email_last_attempt_at, email_error_code FROM organization_invitations WHERE token_hash = ${selector.value} FOR UPDATE`
        : await tx<OrganizationInvitationRow[]>`SELECT id, organization_id, invited_email, role, status, created_at, expires_at, invited_by_user_id, accepted_at,
            email_delivery_status, email_last_attempt_at, email_error_code FROM organization_invitations WHERE id = ${selector.value} FOR UPDATE`;
      if (!invite) return "not_found" as const;
      if (invite.invited_email !== email) return "email_mismatch" as const;
      if (invite.status === "expired") return "expired" as const;
      if (invite.status !== "pending") return "not_pending" as const;
      const [expired] = await tx<{ id: string }[]>`UPDATE organization_invitations SET status = 'expired', updated_at = now()
        WHERE id = ${invite.id} AND expires_at <= now() RETURNING id`;
      if (expired) return "expired" as const;
      if (action === "accept") {
        const [existingMember] = await tx<{ role: OrgRole }[]>`SELECT role FROM organization_members WHERE organization_id = ${invite.organization_id} AND user_id = ${userId} FOR UPDATE`;
        if (!existingMember) {
          const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = ${invite.organization_id}`;
          if (count.n >= MAX_ORGANIZATION_MEMBERS) return "member_limit" as const;
          await tx`INSERT INTO organization_members (organization_id, user_id, role) VALUES (${invite.organization_id}, ${userId}, ${invite.role}) ON CONFLICT (organization_id, user_id) DO NOTHING`;
        }
        await tx`UPDATE organization_invitations SET status = 'accepted', accepted_by_user_id = ${userId}, accepted_at = now(), responded_at = now(), updated_at = now() WHERE id = ${invite.id}`;
        await this.recordOrganizationActivity(tx, { organizationId: invite.organization_id, actorUserId: userId, subjectUserId: userId, event: "invitation_accepted", details: { role: invite.role } });
        return "accepted" as const;
      }
      await tx`UPDATE organization_invitations SET status = 'rejected', responded_at = now(), updated_at = now() WHERE id = ${invite.id}`;
      await this.recordOrganizationActivity(tx, { organizationId: invite.organization_id, actorUserId: null, event: "invitation_rejected" });
      return "rejected" as const;
    }));
  }

  async acceptInvitation(tokenHash: string, userId: string, email: string): Promise<"accepted" | "not_found" | "email_mismatch" | "expired" | "not_pending" | "member_limit"> {
    return this.respondToInvitation({ kind: "token", value: tokenHash }, "accept", userId, email) as Promise<"accepted" | "not_found" | "email_mismatch" | "expired" | "not_pending" | "member_limit">;
  }

  async rejectInvitation(tokenHash: string, userId: string, email: string): Promise<"rejected" | "not_found" | "email_mismatch" | "expired" | "not_pending"> {
    return this.respondToInvitation({ kind: "token", value: tokenHash }, "reject", userId, email) as Promise<"rejected" | "not_found" | "email_mismatch" | "expired" | "not_pending">;
  }

  async acceptInvitationById(invitationId: string, userId: string, email: string): Promise<"accepted" | "not_found" | "email_mismatch" | "expired" | "not_pending" | "member_limit"> {
    return this.respondToInvitation({ kind: "id", value: invitationId }, "accept", userId, email) as Promise<"accepted" | "not_found" | "email_mismatch" | "expired" | "not_pending" | "member_limit">;
  }

  async rejectInvitationById(invitationId: string, userId: string, email: string): Promise<"rejected" | "not_found" | "email_mismatch" | "expired" | "not_pending"> {
    return this.respondToInvitation({ kind: "id", value: invitationId }, "reject", userId, email) as Promise<"rejected" | "not_found" | "email_mismatch" | "expired" | "not_pending">;
  }

  async revokeInvitation(orgId: string, invitationId: string, actorUserId: string) {
    return this.q((sql) => sql.begin(async (tx) => {
      const [org] = await tx<{ id: string }[]>`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
      if (!org) return "not_found" as const;
      const [actor] = await tx<{ role: OrgRole }[]>`SELECT role FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${actorUserId} FOR UPDATE`;
      if (!actor || actor.role === "member") return "forbidden" as const;
      const [invite] = await tx<OrganizationInvitationRow[]>`SELECT id, organization_id, invited_email, role, status, created_at, expires_at, invited_by_user_id, accepted_at,
        email_delivery_status, email_last_attempt_at, email_error_code
        FROM organization_invitations WHERE organization_id = ${orgId} AND id = ${invitationId} FOR UPDATE`;
      if (!invite || invite.status !== "pending") return "not_found" as const;
      const [expired] = await tx<{ id: string }[]>`UPDATE organization_invitations SET status = 'expired', updated_at = now()
        WHERE id = ${invitationId} AND expires_at <= now() RETURNING id`;
      if (expired) return "not_found" as const;
      await tx`UPDATE organization_invitations SET status = 'revoked', responded_at = now(), updated_at = now() WHERE id = ${invitationId}`;
      await this.recordOrganizationActivity(tx, { organizationId: orgId, actorUserId, event: "invitation_revoked" });
      return "revoked" as const;
    }));
  }

  async listOrganizationActivity(orgId: string, limit: number): Promise<OrganizationActivity[]> {
    return this.q(async (sql) => (await sql<OrganizationActivityRow[]>`SELECT a.id, a.event_type,
      actor.display_name AS actor_name, actor.email AS actor_email,
      subject.display_name AS subject_name, subject.email AS subject_email,
      p.hostname AS prospect_hostname, a.details, a.created_at
      FROM organization_activity a
      LEFT JOIN profiles actor ON actor.id = a.actor_user_id
      LEFT JOIN profiles subject ON subject.id = a.subject_user_id
      LEFT JOIN prospects p ON p.id = a.prospect_id
      WHERE a.organization_id = ${orgId}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ${Math.max(1, Math.min(limit, 100))}`).map(rowToOrganizationActivity));
  }

  async logOrganizationActivity(input: { organizationId: string; actorUserId: string | null; event: string; subjectUserId?: string | null; prospectId?: string | null; details?: Record<string, unknown> }) {
    await this.q((sql) => this.recordOrganizationActivity(sql, input));
  }

  async deleteAccountData(userId: string) {
    await this.q((sql) =>
      sql.begin(async (tx) => {
        const pid = `user:${userId}`;
        await tx`DELETE FROM usage_records WHERE principal_id = ${pid}`;
        // Organizations where this user is the only owner are deleted with the account.
        // Detach all shared prospects first so the assignee/organization invariant remains true.
        await tx`UPDATE prospects SET organization_id = NULL, assigned_to_user_id = NULL, updated_at = now()
          WHERE organization_id IN (
            SELECT o.id FROM organizations o
            WHERE EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.user_id = ${userId} AND m.role = 'owner')
              AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.user_id <> ${userId} AND m.role = 'owner')
          )`;
        await tx`DELETE FROM organizations o WHERE EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.user_id = ${userId} AND m.role = 'owner')
                   AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.user_id <> ${userId} AND m.role = 'owner')`;
        await tx`DELETE FROM principals WHERE id = ${pid}`;
        await tx`DELETE FROM profiles WHERE id = ${userId}`;
      }),
    );
  }

  /* ── Account feedback (012) ───────────────────────────────────────────── */

  async countCompletedAuditsForUser(userId: string) {
    return this.q(async (sql) => {
      const [r] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM audits a
        WHERE a.principal_id = ${`user:${userId}`} AND a.status IN ('completed','completed_with_warnings')`;
      return r?.n ?? 0;
    }) as Promise<number>;
  }

  async hasFeedbackSubmission(userId: string) {
    return this.q(async (sql) => {
      const [r] = await sql<{ exists: boolean }[]>`SELECT EXISTS(SELECT 1 FROM feedback_submissions WHERE user_id = ${userId}) AS exists`;
      return !!r?.exists;
    }) as Promise<boolean>;
  }

  async getFeedbackPrompt(userId: string) {
    return this.q(async (sql) => {
      const [r] = await sql<FeedbackPromptRowRaw[]>`SELECT user_id, state, first_offered_at, remind_after, updated_at FROM feedback_prompts WHERE user_id = ${userId}`;
      return r ? rowToFeedbackPrompt(r) : null;
    }) as Promise<FeedbackPromptRow | null>;
  }

  async ensureFeedbackPromptOffered(userId: string) {
    return this.q(async (sql) => {
      await sql`INSERT INTO feedback_prompts (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`;
      const [r] = await sql<FeedbackPromptRowRaw[]>`SELECT user_id, state, first_offered_at, remind_after, updated_at FROM feedback_prompts WHERE user_id = ${userId}`;
      return rowToFeedbackPrompt(r!);
    }) as Promise<FeedbackPromptRow>;
  }

  async setFeedbackPromptResponse(userId: string, input: { state: "remind_later" | "dismissed"; remindAfter: Date | null }) {
    return this.q(async (sql) => {
      const [r] = await sql<FeedbackPromptRowRaw[]>`
        UPDATE feedback_prompts SET state = ${input.state}, remind_after = ${input.remindAfter}, updated_at = now()
        WHERE user_id = ${userId} AND state <> 'dismissed'
        RETURNING user_id, state, first_offered_at, remind_after, updated_at`;
      return r ? rowToFeedbackPrompt(r) : null;
    }) as Promise<FeedbackPromptRow | null>;
  }

  async insertFeedbackSubmission(input: NewFeedbackSubmission) {
    return this.q(async (sql) => {
      const rows = await sql<FeedbackSubmissionRowRaw[]>`
        INSERT INTO feedback_submissions
          (id, user_id, principal_id, account_email, category, rating, message, goal, page_url, idempotency_key)
        VALUES
          (${input.id}, ${input.userId}, ${input.principalId}, ${input.accountEmail}, ${input.category}, ${input.rating}, ${input.message}, ${input.goal}, ${input.pageUrl}, ${input.idempotencyKey})
        ON CONFLICT (user_id, idempotency_key) DO NOTHING
        RETURNING *`;
      if (rows[0]) return { submission: rowToFeedbackSubmission(rows[0]), created: true };
      const [existing] = await sql<FeedbackSubmissionRowRaw[]>`SELECT * FROM feedback_submissions WHERE user_id = ${input.userId} AND idempotency_key = ${input.idempotencyKey}`;
      return { submission: rowToFeedbackSubmission(existing!), created: false };
    }) as Promise<{ submission: FeedbackSubmissionRow; created: boolean }>;
  }

  async updateFeedbackDelivery(userId: string, submissionId: string, patch: { deliveryStatus: FeedbackDeliveryStatus; deliveryErrorCode: string | null; providerMessageId?: string | null; outcomeUncertain?: boolean }) {
    await this.q(async (sql) => {
      await sql`
        UPDATE feedback_submissions
        SET delivery_status = ${patch.deliveryStatus},
            delivery_error_code = ${patch.deliveryErrorCode},
            provider_message_id = COALESCE(${patch.providerMessageId ?? null}, provider_message_id),
            outcome_uncertain = COALESCE(${patch.outcomeUncertain ?? null}, outcome_uncertain),
            updated_at = now()
        WHERE id = ${submissionId} AND user_id = ${userId}`;
    });
  }

  async listUndeliveredFeedback(userId: string, limit: number): Promise<FeedbackSubmissionRow[]> {
    return this.q(async (sql) => {
      const rows = await sql<FeedbackSubmissionRowRaw[]>`
        SELECT * FROM feedback_submissions
        WHERE user_id = ${userId} AND delivery_status = 'failed' AND outcome_uncertain = false
        ORDER BY created_at ASC
        LIMIT ${Math.max(1, Math.min(50, limit))}`;
      return rows.map(rowToFeedbackSubmission);
    }) as Promise<FeedbackSubmissionRow[]>;
  }
}
