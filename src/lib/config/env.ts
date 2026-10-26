import "server-only";
import { checkSupabaseConsistency, type ConfigIssue } from "./consistency";
import { prepareDatabaseUrl } from "../db/url";
import { resolveAppUrl } from "./app-url";
import { z } from "zod";
import { readSupabaseEnv, type SupabaseEnv } from "../auth/supabase-env";
import { buildPlanCatalog, type PlanCatalog } from "../billing/plans";

/**
 * Server-side configuration, read from process.env (Vercel Project Settings →
 * Environment Variables in production, or a local .env file in development).
 *
 * Invalid numeric values never crash the app: they fall back to safe defaults
 * and are reported (by variable NAME only, never value) via `configWarnings`.
 * Secret values are never returned from this module except to the server-side
 * provider adapters that need them.
 */

export type ProviderId = "openrouter" | "gemini";

export interface ScannerConfig {
  /** Operator-wide hard caps. Per-audit limits come from the plan catalog (billing/plans.ts). */
  maxPages: number;
  maxDepth: number;
  maxRedirects: number;
  concurrency: number;
  requestTimeoutMs: number;
  maxBodyBytes: number;
  maxDurationMs: number;
  maxRetries: number;
  hostMinIntervalMs: number;
  maxLinksToCheck: number;
  stepBudgetMs: number;
  allowedPorts: number[];
  userAgent: string;
  maxQueryVariantsPerPath: number;
  maxSitemapFiles: number;
  maxSitemapUrls: number;
}

export interface UsageConfig {
  scansPerWindow: number;
  scanWindowSeconds: number;
  aiRequestsPerWindow: number;
  aiWindowSeconds: number;
  maxAiInputChars: number;
  maxConcurrentScans: number;
  globalMaxConcurrentScans: number;
  historyLimit: number;
  ipLimitMultiplier: number;
  apiRequestsPerMinute: number;
  /** Advanced (costly) checks share one rolling window. */
  advancedWindowSeconds: number;
  browserPagesPerWindow: number;
  accessibilityTestsPerWindow: number;
  performanceTestsPerWindow: number;
  pdfExportsPerWindow: number;
  /** Signed-in accounts keep more history than anonymous browsers. */
  accountHistoryLimit: number;
  /** Short-window caps on top of the main allowances (protect against bursts). */
  auditBurstLimit: number;
  auditBurstWindowSeconds: number;
  aiBurstLimit: number;
  aiBurstWindowSeconds: number;
}

export interface StorageConfig {
  /** Running on a multi-instance serverless platform (Vercel, AWS Lambda, Netlify). */
  serverless: boolean;
  /** Whether the non-durable in-memory store may be used when DATABASE_URL is unset. */
  allowMemory: boolean;
}

export interface BrowserConfig {
  /** Base URL of the SiteInsights browser worker (see /worker). null = feature unavailable. */
  workerUrl: string | null;
  workerToken: string | null;
  maxPagesPerScan: number;
  navigationTimeoutMs: number;
  /** Timeout for one call from the app to the worker. */
  workerTimeoutMs: number;
  accessibility: boolean;
}

export interface PerformanceConfig {
  enabled: boolean;
  apiKey: string | null;
  strategies: ("mobile" | "desktop")[];
  timeoutMs: number;
}

/**
 * Strict BYOK: SiteInsights never holds an AI API key of its own. This config
 * only carries budget limits and default model names — every provider call is
 * authenticated with the requesting user's own key, supplied per request,
 * used request-scoped, and never stored or echoed (see lib/ai/registry.ts).
 */
export interface AIConfig {
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
  openrouter: { model: string };
  gemini: { model: string };
}

export interface AuthConfig {
  supabase: SupabaseEnv;
  /** Deprecated compatibility field. Always false: audit authentication is mandatory. */
  anonymousAudits: boolean;
}

export interface BackgroundConfig {
  /** Shared secret for /api/internal/process (Vercel Cron sends it as a Bearer token). */
  cronSecret: string | null;
  /** How long one background invocation keeps advancing scans after responding. */
  budgetMs: number;
  /** Optional Vercel "Protection Bypass for Automation" secret for self-invocation on protected deployments. */
  bypassSecret: string | null;
}

export interface AppConfig {
  appUrl: string | null;
  /** Where appUrl came from (null = each request's own origin). */
  appUrlSource: "NEXT_PUBLIC_APP_URL" | "VERCEL_PROJECT_PRODUCTION_URL" | null;
  contactEmail: string | null;
  databaseUrl: string | null;
  /** Name of the database variable that is set but unusable (see db/url.ts), else null. */
  databaseUrlInvalid: string | null;
  /** Which variable provided the database URL (name only), e.g. "POSTGRES_URL". */
  databaseUrlSource: string | null;
  /** Session/direct connection to the SAME database, used only for automatic migrations. */
  migrationDatabaseUrl: string | null;
  migrationDatabaseUrlSource: string | null;
  /** Structured configuration problems (variable names + fixes; never values). */
  configIssues: ConfigIssue[];
  auth: AuthConfig;
  background: BackgroundConfig;
  dbAutoMigrate: boolean;
  dbSsl: "require" | "disable" | "prefer" | null;
  sessionSecret: string | null;
  storage: StorageConfig;
  browser: BrowserConfig;
  performance: PerformanceConfig;
  scanner: ScannerConfig;
  usage: UsageConfig;
  ai: AIConfig;
  /** Authoritative plans, credit allowances and credit costs. */
  plans: PlanCatalog;
  billing: BillingConfig;
  warnings: string[];
}

export interface BillingConfig {
  /** Configured provider id (BILLING_PROVIDER). null = payments not configured; paid checkout stays disabled. */
  provider: string | null;
  /** Paddle adapter configuration (credentials stay server-side; never exposed to clients or logs). */
  paddle: PaddleConfig;
}

export interface PaddleConfig {
  /** Paddle environment (PADDLE_ENV, fallback NEXT_PUBLIC_PADDLE_ENV). Default "sandbox". */
  environment: "sandbox" | "production";
  /** Server API key (PADDLE_API_KEY) — `pdl_sdbx_apikey_…` in sandbox. Server-side only. */
  apiKey: string | null;
  /** Notification-destination secret for webhook signatures (PADDLE_NOTIFICATION_WEBHOOK_SECRET). Server-side only. */
  webhookSecret: string | null;
  /** Paddle price id for the Pro plan (PADDLE_PRICE_PRO, `pri_…`). */
  pricePro: string | null;
  /** Paddle price id for the Business plan (PADDLE_PRICE_BUSINESS, `pri_…`). */
  priceBusiness: string | null;
}

/** Reads the Paddle billing variables from the environment. Pure; exported for tests. Never logs values. */
export function readPaddleEnv(env: Env): PaddleConfig {
  const environment = (str(env, "PADDLE_ENV") ?? str(env, "NEXT_PUBLIC_PADDLE_ENV") ?? "").toLowerCase() === "production" ? "production" : "sandbox";
  return {
    environment,
    apiKey: str(env, "PADDLE_API_KEY"),
    webhookSecret: str(env, "PADDLE_NOTIFICATION_WEBHOOK_SECRET"),
    pricePro: str(env, "PADDLE_PRICE_PRO"),
    priceBusiness: str(env, "PADDLE_PRICE_BUSINESS"),
  };
}

type Env = Record<string, string | undefined>;

function str(env: Env, name: string): string | null {
  const v = env[name];
  if (v === undefined) return null;
  const t = v.trim();
  return t.length ? t : null;
}

function int(env: Env, warnings: string[], name: string, def: number, min: number, max: number): number {
  const raw = str(env, name);
  if (raw === null) return def;
  const parsed = z.coerce.number().int().min(min).max(max).safeParse(raw);
  if (!parsed.success) {
    warnings.push(`${name} is invalid (expected an integer between ${min} and ${max}); using default ${def}.`);
    return def;
  }
  return parsed.data;
}

function bool(env: Env, warnings: string[], name: string, def: boolean): boolean {
  const raw = str(env, name);
  if (raw === null) return def;
  const v = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  warnings.push(`${name} is invalid (expected true or false); using default ${def}.`);
  return def;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const warnings: string[] = [];

  // Paddle Live vs Sandbox coherence: a key from one environment with PADDLE_ENV
  // pointing at the other would charge the wrong environment or fail confusingly.
  // The provider also fails closed (registry shows "misconfigured"). Values are
  // never echoed — variable names and expected prefixes only.
  const paddleCfg = readPaddleEnv(env);
  if (paddleCfg.apiKey) {
    const expected = paddleCfg.environment === "production" ? "pdl_live_apikey_" : "pdl_sdbx_apikey_";
    if (!paddleCfg.apiKey.startsWith(expected)) {
      warnings.push(`PADDLE_API_KEY does not look like a ${paddleCfg.environment} key (expected it to start with "${expected}"). Check PADDLE_ENV and the key match the same Paddle environment; paid checkout stays disabled.`);
    }
    if ((paddleCfg.pricePro && !paddleCfg.pricePro.startsWith("pri_")) || (paddleCfg.priceBusiness && !paddleCfg.priceBusiness.startsWith("pri_"))) {
      warnings.push("PADDLE_PRICE_PRO / PADDLE_PRICE_BUSINESS must be Paddle price ids starting with \"pri_\"; paid checkout stays disabled.");
    }
  }

  // Legacy owner-supplied AI keys/providers are not read: BYOK (see AIConfig).
  if (str(env, "OPENROUTER_API_KEY") !== null || str(env, "GEMINI_API_KEY") !== null) {
    warnings.push("OPENROUTER_API_KEY/GEMINI_API_KEY are no longer used: SiteInsights is BYOK — each user supplies their own AI key per session. Remove these variables.");
  }
  for (const legacy of ["AI_PROVIDER", "AI_FALLBACK_ENABLED"]) {
    if (str(env, legacy) !== null) warnings.push(`${legacy} is no longer used (BYOK provider choice is per user). You may remove it.`);
  }

  // Public origin for links in emails / OAuth callbacks (never localhost in production; see app-url.ts).
  const appUrlResolution = resolveAppUrl(env);
  const appUrl = appUrlResolution.appUrl;

  const portsRaw = str(env, "SCAN_ALLOWED_PORTS") ?? "80,443,8080,8443";
  const allowedPorts = portsRaw
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  if (allowedPorts.length === 0) {
    warnings.push("SCAN_ALLOWED_PORTS contained no valid ports; using 80,443.");
    allowedPorts.push(80, 443);
  }

  const sslRaw = str(env, "DATABASE_SSL")?.toLowerCase() ?? null;
  const dbSsl = sslRaw === "require" || sslRaw === "disable" || sslRaw === "prefer" ? sslRaw : null;
  if (sslRaw && !dbSsl) warnings.push("DATABASE_SSL must be require, prefer or disable; using automatic detection.");

  const contactRaw = str(env, "NEXT_PUBLIC_CONTACT_EMAIL");
  const contactEmail = contactRaw && z.email().safeParse(contactRaw).success ? contactRaw : null;

  const plans = buildPlanCatalog(env, warnings);
  const scanner: ScannerConfig = {
    // Hard caps; each audit uses min(hard cap, plan limit, user-requested limit).
    maxPages: plans.hardMaxPages,
    maxDepth: int(env, warnings, "SCAN_HARD_MAX_DEPTH", 15, 0, 15),
    maxRedirects: int(env, warnings, "SCAN_MAX_REDIRECTS", 5, 0, 10),
    concurrency: int(env, warnings, "SCAN_CONCURRENCY", 4, 1, 10),
    requestTimeoutMs: int(env, warnings, "SCAN_REQUEST_TIMEOUT_MS", 8000, 1000, 30000),
    maxBodyBytes: int(env, warnings, "SCAN_MAX_BODY_BYTES", 2_000_000, 50_000, 10_000_000),
    maxDurationMs: int(env, warnings, "SCAN_MAX_DURATION_MS", 1_800_000, 10_000, 1_800_000),
    maxRetries: int(env, warnings, "SCAN_MAX_RETRIES", 1, 0, 3),
    hostMinIntervalMs: int(env, warnings, "SCAN_HOST_MIN_INTERVAL_MS", 250, 0, 5000),
    maxLinksToCheck: int(env, warnings, "SCAN_MAX_LINKS_TO_CHECK", 5000, 0, 5000),
    stepBudgetMs: int(env, warnings, "SCAN_STEP_BUDGET_MS", 20_000, 3000, 240_000),
    allowedPorts,
    userAgent:
      str(env, "SCAN_USER_AGENT") ??
      (() => {
        // Point site owners at this deployment's crawler documentation; never at a domain we do not control.
        const host = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL;
        const base = appUrl ?? (host ? `https://${host}` : null);
        return `Mozilla/5.0 (compatible; SiteLensAI/0.2${base ? `; +${base.replace(/\/$/, "")}/help#crawler` : ""})`;
      })(),
    maxQueryVariantsPerPath: int(env, warnings, "SCAN_MAX_QUERY_VARIANTS", 3, 0, 50),
    maxSitemapFiles: int(env, warnings, "SCAN_MAX_SITEMAP_FILES", 4, 0, 20),
    maxSitemapUrls: int(env, warnings, "SCAN_MAX_SITEMAP_URLS", 2000, 0, 10_000),
  };
  // Honest configuration feedback: a hard cap below a plan limit silently shrinks that plan.
  for (const p of Object.values(plans.plans)) {
    if (scanner.maxDurationMs < p.maxDurationMs) warnings.push(`SCAN_MAX_DURATION_MS is lower than the ${p.name} plan's audit time budget (${p.maxDurationMs} ms); large ${p.name} audits will stop early. Raise or remove SCAN_MAX_DURATION_MS.`);
    if (scanner.maxLinksToCheck < p.maxLinksToCheck) warnings.push(`SCAN_MAX_LINKS_TO_CHECK is lower than the ${p.name} plan's link-check limit (${p.maxLinksToCheck}). Raise or remove SCAN_MAX_LINKS_TO_CHECK.`);
    if (scanner.maxDepth < p.maxDepth) warnings.push(`SCAN_HARD_MAX_DEPTH is lower than the ${p.name} plan's crawl depth (${p.maxDepth}).`);
  }

  const usage: UsageConfig = {
    scansPerWindow: plans.plans.free.auditsPerDay,
    scanWindowSeconds: int(env, warnings, "FREE_SCAN_WINDOW_SECONDS", 86_400, 60, 2_592_000),
    aiRequestsPerWindow: int(env, warnings, "FREE_AI_REQUESTS_PER_WINDOW", 30, 0, 100_000),
    aiWindowSeconds: int(env, warnings, "FREE_AI_WINDOW_SECONDS", 86_400, 60, 2_592_000),
    maxAiInputChars: int(env, warnings, "FREE_MAX_AI_INPUT_CHARS", 12_000, 1000, 200_000),
    maxConcurrentScans: plans.plans.free.maxConcurrentAudits,
    globalMaxConcurrentScans: int(env, warnings, "GLOBAL_MAX_CONCURRENT_SCANS", 25, 1, 10_000),
    historyLimit: int(env, warnings, "FREE_HISTORY_LIMIT", 20, 1, 1000),
    accountHistoryLimit: plans.plans.free.historyLimit,
    auditBurstLimit: int(env, warnings, "AUDIT_BURST_LIMIT", 5, 1, 10_000),
    auditBurstWindowSeconds: int(env, warnings, "AUDIT_BURST_WINDOW_SECONDS", 600, 10, 86_400),
    aiBurstLimit: int(env, warnings, "AI_BURST_LIMIT", 10, 1, 10_000),
    aiBurstWindowSeconds: int(env, warnings, "AI_BURST_WINDOW_SECONDS", 60, 10, 86_400),
    ipLimitMultiplier: int(env, warnings, "FREE_IP_LIMIT_MULTIPLIER", 3, 1, 100),
    apiRequestsPerMinute: int(env, warnings, "API_RATE_LIMIT_PER_MINUTE", 120, 10, 10_000),
    advancedWindowSeconds: int(env, warnings, "FREE_ADVANCED_WINDOW_SECONDS", 86_400, 60, 2_592_000),
    browserPagesPerWindow: int(env, warnings, "FREE_BROWSER_PAGES_PER_WINDOW", 30, 0, 100_000),
    accessibilityTestsPerWindow: int(env, warnings, "FREE_ACCESSIBILITY_TESTS_PER_WINDOW", 30, 0, 100_000),
    performanceTestsPerWindow: int(env, warnings, "FREE_PERFORMANCE_TESTS_PER_WINDOW", 10, 0, 100_000),
    pdfExportsPerWindow: int(env, warnings, "FREE_PDF_EXPORTS_PER_WINDOW", 20, 0, 100_000),
  };

  // ── Storage policy ────────────────────────────────────────────────────────
  // Serverless platforms run many short-lived instances that do not share
  // memory, so the in-memory store cannot work there: a scan created by one
  // instance is invisible to the next request. It is therefore never used on
  // serverless hosting, and is opt-in for other production servers.
  const serverless = env.VERCEL === "1" || !!env.AWS_LAMBDA_FUNCTION_NAME || env.NETLIFY === "true";
  const allowMemoryRaw = bool(env, warnings, "ALLOW_MEMORY_STORAGE", env.NODE_ENV !== "production");
  if (serverless && allowMemoryRaw && str(env, "ALLOW_MEMORY_STORAGE") !== null) {
    warnings.push("ALLOW_MEMORY_STORAGE is ignored on serverless hosting: instances do not share memory. Set DATABASE_URL (or connect Supabase, which sets POSTGRES_URL).");
  }
  const storage: StorageConfig = { serverless, allowMemory: allowMemoryRaw && !serverless };

  // ── Browser worker (JavaScript rendering + axe-core) ─────────────────────
  let workerUrl = str(env, "BROWSER_WORKER_URL");
  if (workerUrl) {
    try {
      const u = new URL(workerUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
      if (u.protocol === "http:" && env.NODE_ENV === "production" && !["localhost", "127.0.0.1"].includes(u.hostname)) {
        warnings.push("BROWSER_WORKER_URL uses plain http in production; use https so the worker token is not sent in clear text.");
      }
      workerUrl = u.toString().replace(/\/$/, "");
    } catch {
      warnings.push("BROWSER_WORKER_URL is not a valid http(s) URL; browser rendering is disabled.");
      workerUrl = null;
    }
  }
  const workerToken = str(env, "BROWSER_WORKER_TOKEN");
  if (workerUrl && (!workerToken || workerToken.length < 24)) {
    warnings.push("BROWSER_WORKER_TOKEN must be set (at least 24 characters) to use the browser worker; browser rendering is disabled.");
  }
  const browserEnabled = !!workerUrl && !!workerToken && workerToken.length >= 24;
  const browser: BrowserConfig = {
    workerUrl: browserEnabled ? workerUrl : null,
    workerToken: browserEnabled ? workerToken : null,
    maxPagesPerScan: int(env, warnings, "BROWSER_MAX_PAGES", 5, 0, 25),
    navigationTimeoutMs: int(env, warnings, "BROWSER_NAV_TIMEOUT_MS", 20_000, 5000, 60_000),
    workerTimeoutMs: int(env, warnings, "BROWSER_WORKER_TIMEOUT_MS", 45_000, 10_000, 80_000),
    accessibility: bool(env, warnings, "BROWSER_ACCESSIBILITY_ENABLED", true),
  };

  // ── Performance (Google PageSpeed Insights API) ───────────────────────────
  const psiKey = str(env, "PAGESPEED_API_KEY");
  const strategiesRaw = (str(env, "PAGESPEED_STRATEGIES") ?? "mobile,desktop").split(",").map((x) => x.trim().toLowerCase());
  const strategies = (["mobile", "desktop"] as const).filter((x) => strategiesRaw.includes(x));
  if (!strategies.length) warnings.push("PAGESPEED_STRATEGIES must contain mobile and/or desktop; using mobile.");
  const performance: PerformanceConfig = {
    enabled: bool(env, warnings, "PAGESPEED_ENABLED", !!psiKey),
    apiKey: psiKey,
    strategies: strategies.length ? [...strategies] : ["mobile"],
    timeoutMs: int(env, warnings, "PAGESPEED_TIMEOUT_MS", 60_000, 10_000, 80_000),
  };

  const ai: AIConfig = {
    timeoutMs: int(env, warnings, "AI_TIMEOUT_MS", 45_000, 5000, 120_000),
    maxRetries: int(env, warnings, "AI_MAX_RETRIES", 1, 0, 4),
    maxOutputTokens: int(env, warnings, "AI_MAX_OUTPUT_TOKENS", 2000, 256, 16_000),
    openrouter: { model: str(env, "OPENROUTER_MODEL") ?? "openrouter/auto" },
    gemini: { model: str(env, "GEMINI_MODEL") ?? "gemini-flash-latest" },
  };

  const sessionSecret = str(env, "SESSION_SECRET");
  if (!sessionSecret && env.NODE_ENV === "production") {
    warnings.push("SESSION_SECRET is not set; IP addresses are hashed with a built-in salt and provider-avatar markers are disabled. Set a long random value.");
  } else if (sessionSecret && new TextEncoder().encode(sessionSecret).byteLength < 32) {
    warnings.push("SESSION_SECRET is shorter than 32 bytes; provider-avatar markers are disabled. Set at least 32 random bytes.");
  }

  // ── Database URL ─────────────────────────────────────────────────────────
  // DATABASE_URL wins; otherwise the pooled URL created by the Supabase ↔ Vercel
  // integration (POSTGRES_URL). Driver-incompatible query parameters added by
  // poolers/ORMs are removed (see normalizeDatabaseUrl).
  const dbName = ["DATABASE_URL", "POSTGRES_URL"].find((n) => str(env, n) !== null) ?? null;
  let databaseUrl: string | null = null;
  const urlIssues: ConfigIssue[] = [];
  if (dbName) {
    const prepared = prepareDatabaseUrl(str(env, dbName)!, dbName);
    databaseUrl = prepared.url;
    urlIssues.push(...prepared.issues);
  }

  const supabase = readSupabaseEnv(env);
  warnings.push(...supabase.warnings);
  const consistency = checkSupabaseConsistency(env, { serverless: storage.serverless });
  const migrationName = consistency.migrationDb?.variable ?? null;
  let migrationDatabaseUrl: string | null = null;
  if (migrationName && databaseUrl) {
    const prepared = prepareDatabaseUrl(str(env, migrationName)!, migrationName);
    migrationDatabaseUrl = prepared.url;
    urlIssues.push(...prepared.issues);
  }
  // Feedback email (Mailjet SMTP, server-only). Names mirror scripts/email/smtp-config.mjs.
  // Partial or mismatched configuration fails closed (the API answers email_not_configured),
  // so surface problems here instead of at provider time.
  const smtpPresent = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "EMAIL_FROM"].filter((n) => str(env, n) !== null);
  const smtpIssues: ConfigIssue[] = [];
  if (smtpPresent.length > 0) {
    const missing = ["SMTP_USER", "SMTP_PASS", "EMAIL_FROM"].filter((n) => !smtpPresent.includes(n));
    if (missing.length) smtpIssues.push({ severity: "error", variables: missing, problem: "Feedback email is partially configured; missing values mean delivery is disabled.", fix: "Set SMTP_USER, SMTP_PASS and EMAIL_FROM (the SMTP_HOST/SMTP_PORT/SMTP_SECURE defaults are fine). Allowed SMTP_HOST values: in-v3.mailjet.com (Mailjet) and smtp-relay.brevo.com (Brevo)." });
    const host = (str(env, "SMTP_HOST") ?? "in-v3.mailjet.com").toLowerCase();
    if (!["in-v3.mailjet.com", "smtp-relay.brevo.com"].includes(host)) smtpIssues.push({ severity: "error", variables: ["SMTP_HOST"], problem: "Feedback SMTP only ever authenticates to an allowlisted relay (in-v3.mailjet.com or smtp-relay.brevo.com).", fix: "Keep SMTP_HOST set to one of those exact hosts; never point those credentials at another host." });
    const port = str(env, "SMTP_PORT") ?? "587";
    const secure = str(env, "SMTP_SECURE") ?? "false";
    if (!((port === "587" && secure === "false") || (port === "465" && secure === "true"))) smtpIssues.push({ severity: "error", variables: ["SMTP_PORT", "SMTP_SECURE"], problem: "SMTP_PORT/SMTP_SECURE combination is not a valid Mailjet pairing (587+false or 465+true).", fix: "Use SMTP_PORT=587 with SMTP_SECURE=false (STARTTLS) or SMTP_PORT=465 with SMTP_SECURE=true." });
    const from = str(env, "EMAIL_FROM");
    if (from && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) smtpIssues.push({ severity: "error", variables: ["EMAIL_FROM"], problem: "EMAIL_FROM is not a valid email address.", fix: "Set EMAIL_FROM to the Mailjet-verified sender address." });
  }

  const configIssues = [...urlIssues, ...appUrlResolution.issues, ...consistency.issues, ...smtpIssues];
  for (const i of configIssues) warnings.push(`${i.problem} Fix: ${i.fix}`);
  if (supabase.authEnabled && !databaseUrl) warnings.push("Supabase sign-in is configured but no database URL is set. Set DATABASE_URL (or connect the Supabase integration, which sets POSTGRES_URL).");
  const cronSecret = str(env, "CRON_SECRET");
  if (cronSecret && cronSecret.length < 16) warnings.push("CRON_SECRET should be at least 16 characters.");

  return {
    appUrl,
    appUrlSource: appUrlResolution.source,
    contactEmail,
    databaseUrl,
    databaseUrlSource: databaseUrl ? dbName : null,
    databaseUrlInvalid: dbName && !databaseUrl ? dbName : null,
    migrationDatabaseUrl,
    migrationDatabaseUrlSource: migrationDatabaseUrl ? migrationName : null,
    configIssues,
    auth: { supabase, anonymousAudits: false },
    background: {
      cronSecret: cronSecret && cronSecret.length >= 16 ? cronSecret : null,
      budgetMs: int(env, warnings, "BACKGROUND_BUDGET_MS", 50_000, 5_000, 250_000),
      bypassSecret: str(env, "VERCEL_AUTOMATION_BYPASS_SECRET"),
    },
    dbAutoMigrate: bool(env, warnings, "DB_AUTO_MIGRATE", true),
    dbSsl,
    sessionSecret,
    storage,
    browser,
    performance,
    scanner,
    usage,
    ai,
    plans,
    billing: { provider: str(env, "BILLING_PROVIDER")?.toLowerCase() ?? null, paddle: readPaddleEnv(env) },
    warnings,
  };
}

/**
 * Validates a postgres:// URL and drops query parameters the `postgres` driver
 * would forward to the server as unknown settings (added by the Supabase
 * integration or Prisma: supa, pgbouncer, connection_limit, pool_timeout, schema).
 */
export function normalizeDatabaseUrl(raw: string): string | null {
  return prepareDatabaseUrl(raw, "DATABASE_URL").url;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: reset memoised configuration. */
export function __resetConfigForTests() {
  cached = null;
}
