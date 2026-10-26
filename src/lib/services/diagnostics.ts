import "server-only";
import { supportedProviders } from "../ai/registry";
import { getAuthProviders } from "../auth/providers";
import { supabaseAdmin } from "../auth/server";
import { checkWorkerHealth } from "../browser/client";
import { getConfig } from "../config/env";
import { getRepository, storageInfo, type StorageInfo } from "../db";
import { classifyDatabaseError, PROBLEMS, type DatabaseProblem } from "../db/errors";
import type { DatabaseHealth, PostgresRepository } from "../db/postgres";
import { backgroundMode } from "./background";
import { availableChecks } from "./scans";

/** Variables reported as set/unset by diagnostics (names only — never values). */
const REPORTED_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_URL_NON_POOLING",
  "MIGRATION_DATABASE_URL",
  "DB_AUTO_MIGRATE",
  "NEXT_PUBLIC_APP_URL",
  "SESSION_SECRET",
  "CRON_SECRET",
  "BROWSER_WORKER_URL",
  "BROWSER_WORKER_TOKEN",
  "PAGESPEED_API_KEY",
  "AI_PROVIDER",
  "AI_FALLBACK_ENABLED",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASS",
  "EMAIL_FROM",
] as const;

export interface StorageStatus extends StorageInfo {
  /** Problem code when the database is configured but not usable (see db/errors.ts). */
  problem: DatabaseProblem | null;
}

let probeCache: { at: number; value: DatabaseHealth } | null = null;

/** Live database probe, cached briefly so the public status endpoint can't be used to load the database. */
export async function databaseHealth(maxAgeMs = 15_000): Promise<DatabaseHealth | null> {
  const info = storageInfo();
  if (info.mode !== "postgres") return null;
  if (probeCache && Date.now() - probeCache.at < maxAgeMs) return probeCache.value;
  let value: DatabaseHealth;
  try {
    value = await (getRepository() as unknown as PostgresRepository).health();
  } catch (err) {
    // getRepository() throws a classified problem when the URL is unusable.
    value = { ok: false, problem: classifyDatabaseError(err) ?? "database_misconfigured", missingMigrations: [], supabaseAuthSchema: null, migrationConnection: "runtime" };
  }
  probeCache = { at: Date.now(), value };
  return value;
}

export function __resetDiagnosticsCache() {
  probeCache = null;
}

export async function storageStatus(): Promise<StorageStatus> {
  const info = storageInfo();
  const h = await databaseHealth();
  return { ...info, ready: info.ready && (h ? h.ok : true), problem: h?.problem ?? null };
}

type Check = { status: "ok" | "warning" | "error" | "not_configured"; detail: string; fix?: string };

/**
 * Full operator diagnostics (protected by CRON_SECRET). Everything here is
 * derived from live checks; values of variables are never included.
 */
export async function runDiagnostics() {
  const cfg = getConfig();
  const env = process.env;
  const checks: Record<string, Check> = {};

  // Database
  const db = await databaseHealth(0);
  if (!db) {
    checks.database = { status: "error", detail: "No database URL is configured.", fix: "Set DATABASE_URL to the Supabase transaction pooler URL (port 6543), or connect the Supabase integration (POSTGRES_URL)." };
  } else if (db.problem) {
    checks.database = { status: "error", detail: `${db.problem}${db.missingMigrations.length ? ` (missing migrations: ${db.missingMigrations.join(", ")})` : ""}`, fix: PROBLEMS[db.problem].hint };
  } else {
    checks.database = { status: "ok", detail: `Reachable through ${cfg.databaseUrlSource}; schema up to date; migrations use ${db.migrationConnection === "separate" ? cfg.migrationDatabaseUrlSource : "the runtime connection"}.` };
  }

  // Auth (Supabase)
  const sb = cfg.auth.supabase;
  let authProviders: Awaited<ReturnType<typeof getAuthProviders>> | null = null;
  if (!sb.authEnabled) {
    checks.auth = { status: "not_configured", detail: "Accounts are off.", fix: "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY from the same Supabase project as the database." };
  } else {
    authProviders = await getAuthProviders();
    checks.auth = authProviders.unavailable
      ? { status: "error", detail: `GET ${sb.sources.url}/auth/v1/settings failed (wrong URL or publishable key).`, fix: `Copy the Project URL and publishable key from the same project's Settings → API Keys into ${sb.sources.url} and ${sb.sources.publishableKey}.` }
      : { status: "ok", detail: `Auth reachable. Enabled sign-in methods: ${["email", "google", "github", "saml"].filter((k) => authProviders![k as "email"]).join(", ") || "none"}.` };
    for (const p of ["google", "github"] as const) {
      if (!authProviders.unavailable && !authProviders[p]) {
        checks[`oauth_${p}`] = { status: "not_configured", detail: `${p === "google" ? "Google" : "GitHub"} is not enabled in this Supabase project, so its button is hidden.`, fix: "Enable it in Supabase → Authentication → Sign In / Providers (see docs/SUPABASE.md › OAuth)." };
      } else if (!authProviders.unavailable) {
        checks[`oauth_${p}`] = { status: "ok", detail: "Enabled in Supabase; the sign-in button is shown. A real sign-in is the only end-to-end proof of the provider credentials." };
      }
    }
  }

  // Auth ↔ database: same project? Proven with a real user id when the secret key is available.
  if (sb.authEnabled && db && !db.problem) {
    const admin = supabaseAdmin();
    if (db.supabaseAuthSchema === false) {
      checks.project_match = { status: "warning", detail: "The database has no auth.users table, so it is not a Supabase project database.", fix: "Use the database of the Supabase project in NEXT_PUBLIC_SUPABASE_URL." };
    } else if (!admin) {
      checks.project_match = { status: "warning", detail: "Can't verify without SUPABASE_SECRET_KEY; compare the project refs below instead." };
    } else {
      try {
        const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
        if (error) throw error;
        const u = data.users[0];
        if (!u) checks.project_match = { status: "warning", detail: "The Auth project has no users yet, so the database can't be cross-checked." };
        else {
          const exists = await (getRepository() as unknown as PostgresRepository).authUserLinkable(u.id);
          checks.project_match =
            exists === false
              ? { status: "error", detail: "Users of the Auth project do not exist in the database: Auth and the database belong to different Supabase projects.", fix: PROBLEMS.supabase_project_mismatch.hint }
              : { status: "ok", detail: "Auth and the database belong to the same Supabase project (verified with a real user id)." };
        }
      } catch {
        checks.project_match = { status: "warning", detail: `The Auth admin API rejected ${sb.sources.secretKey}; it may belong to another project.`, fix: "Copy the secret key from the same project's Settings → API Keys." };
      }
    }
  }

  // Background processing
  const bg = backgroundMode();
  checks.background = bg === "full"
    ? { status: "ok", detail: "Audits keep running after the browser is closed (cron sweep + self-invocation)." }
    : bg === "limited"
      ? { status: "warning", detail: "Without CRON_SECRET, an audit runs for about 50 s after it starts and then only while its page is open.", fix: "Set CRON_SECRET (16+ random characters) in Vercel and redeploy." }
      : { status: "warning", detail: "BACKGROUND_PROCESSING=false: audits advance only while their page is open." };

  // Optional checks
  const a = availableChecks();
  if (!cfg.browser.workerUrl) {
    checks.browser_worker = { status: "not_configured", detail: "Browser rendering and the axe accessibility scan are off.", fix: "Deploy /worker (see docs/DEPLOYMENT.md › Browser worker) and set BROWSER_WORKER_URL and BROWSER_WORKER_TOKEN." };
  } else {
    const h = await checkWorkerHealth({ workerUrl: cfg.browser.workerUrl, token: cfg.browser.workerToken!, timeoutMs: cfg.browser.workerTimeoutMs });
    checks.browser_worker = h.ok
      ? { status: "ok", detail: `Worker reachable (accessibility ${a.accessibility ? "on" : "off"}, up to ${a.browserPages} rendered pages per audit).` }
      : { status: "error", detail: `Worker check failed: ${h.message}.`, fix: h.message === "Token rejected" ? "BROWSER_WORKER_TOKEN must equal the worker's WORKER_TOKEN." : "Check BROWSER_WORKER_URL and that the worker service is running." };
  }
  checks.performance = !cfg.performance.enabled
    ? { status: "not_configured", detail: "Lighthouse performance checks are turned off.", fix: "Set PAGESPEED_API_KEY (and remove PAGESPEED_ENABLED=false if present)." }
    : cfg.performance.apiKey
      ? { status: "ok", detail: `PageSpeed Insights key set (${a.performanceStrategies.join(", ")}). Quota or key errors are reported per audit.` }
      : { status: "warning", detail: "No PAGESPEED_API_KEY: Google's shared keyless quota is usually exhausted, so performance is often reported as unavailable.", fix: "Create a PageSpeed Insights API key in Google Cloud and set PAGESPEED_API_KEY." };
  checks.ai = {
    status: "ok",
    detail: `Strict BYOK: ${supportedProviders(cfg.ai).map((pp) => pp.label).join(" and ")} are supported; every AI request uses the requesting user's own key, held in their browser memory only. There is no server-side AI key to check.`,
  };

  return {
    checks,
    configIssues: cfg.configIssues,
    configWarnings: [...cfg.warnings],
    variables: Object.fromEntries(REPORTED_VARS.map((n) => [n, env[n]?.trim() ? "set" : "unset"])),
    used: { database: cfg.databaseUrlSource, migrations: cfg.migrationDatabaseUrlSource ?? cfg.databaseUrlSource, supabaseUrl: sb.sources.url, publishableKey: sb.sources.publishableKey, secretKey: sb.sources.secretKey },
  };
}
