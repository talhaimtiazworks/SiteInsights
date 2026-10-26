/**
 * Google PageSpeed Insights (PSI) v5 client.
 *
 * - LAB data comes from a Lighthouse run on Google's servers (simulated device
 *   and network). Lab metrics: FCP, LCP, TBT, CLS, Speed Index.
 * - FIELD data comes from the Chrome UX Report (real Chrome users, 28-day
 *   p75). Field metrics: LCP, INP, CLS, FCP, TTFB. INP exists ONLY as field
 *   data; Total Blocking Time is a lab proxy and is never presented as INP.
 * - The API key is sent in the X-goog-api-key header, never in the URL, so it
 *   cannot leak through logs or error messages.
 */

export type Strategy = "mobile" | "desktop";
export type FieldCategory = "good" | "needs_improvement" | "poor";

export interface FieldMetric {
  p75: number;
  category: FieldCategory;
}

export interface PerformanceRun {
  strategy: Strategy;
  url: string;
  finalUrl: string | null;
  ok: boolean;
  fetchedAt: string;
  error: { code: PerformanceErrorCode; message: string } | null;
  lighthouseVersion: string | null;
  /** Lighthouse performance score 0–100 (lab). null when not available. */
  score: number | null;
  lab: { fcpMs: number | null; lcpMs: number | null; tbtMs: number | null; cls: number | null; speedIndexMs: number | null };
  /** null = Chrome UX Report has no data for this URL or its origin. */
  field: {
    scope: "url" | "origin";
    overall: FieldCategory | null;
    lcp: FieldMetric | null;
    inp: FieldMetric | null;
    cls: FieldMetric | null;
    fcp: FieldMetric | null;
    ttfb: FieldMetric | null;
  } | null;
  resources: {
    totalBytes: number | null;
    requestCount: number | null;
    renderBlocking: Array<{ url: string; wastedMs: number | null }>;
    unusedJsBytes: number | null;
    imageSavingsBytes: number | null;
    cacheIssues: number | null;
  };
  opportunities: Array<{ id: string; title: string; savingsMs: number | null; savingsBytes: number | null; displayValue: string | null }>;
  warnings: string[];
}

export type PerformanceErrorCode = "not_configured" | "auth_failed" | "rate_limited" | "quota_exhausted" | "timeout" | "lighthouse_failed" | "invalid_response" | "provider_unavailable" | "network_error";

export interface PageSpeedClientOptions {
  /** Optional: without a key Google applies a small shared quota. */
  apiKey: string | null;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export function emptyRun(url: string, strategy: Strategy, error: PerformanceRun["error"]): PerformanceRun {
  return {
    strategy,
    url,
    finalUrl: null,
    ok: false,
    fetchedAt: new Date().toISOString(),
    error,
    lighthouseVersion: null,
    score: null,
    lab: { fcpMs: null, lcpMs: null, tbtMs: null, cls: null, speedIndexMs: null },
    field: null,
    resources: { totalBytes: null, requestCount: null, renderBlocking: [], unusedJsBytes: null, imageSavingsBytes: null, cacheIssues: null },
    opportunities: [],
    warnings: [],
  };
}

export async function runPageSpeed(url: string, strategy: Strategy, opts: PageSpeedClientOptions): Promise<PerformanceRun> {
  const f = opts.fetchImpl ?? fetch;
  const qs = new URLSearchParams({ url, strategy, category: "performance" });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  let res: Response;
  try {
    res = await f(`${opts.endpoint ?? ENDPOINT}?${qs}`, { headers: { ...(opts.apiKey ? { "X-goog-api-key": opts.apiKey } : {}), Accept: "application/json" }, signal: ctrl.signal, cache: "no-store" });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as Error)?.name === "AbortError";
    return emptyRun(url, strategy, aborted ? { code: "timeout", message: `PageSpeed Insights did not respond within ${Math.round(opts.timeoutMs / 1000)} s.` } : { code: "network_error", message: "PageSpeed Insights could not be reached." });
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* handled below */
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return emptyRun(url, strategy, mapHttpError(res.status, body));
  if (!body || typeof body !== "object") return emptyRun(url, strategy, { code: "invalid_response", message: "PageSpeed Insights returned an unreadable response." });
  try {
    return parsePageSpeed(body as Record<string, unknown>, url, strategy);
  } catch {
    return emptyRun(url, strategy, { code: "invalid_response", message: "PageSpeed Insights returned a response in an unexpected format." });
  }
}

function mapHttpError(status: number, body: unknown): NonNullable<PerformanceRun["error"]> {
  const raw = String((body as { error?: { message?: unknown } } | null)?.error?.message ?? "");
  // Lighthouse failures (site unreachable, timed out, not HTML…) arrive as 400/500 with a Lighthouse code.
  const lh = /(FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST|NO_FCP|NO_LCP|PAGE_HUNG|DNS_FAILURE|NOT_HTML|INSECURE_DOCUMENT_REQUEST|CHROME_INTERSTITIAL_ERROR|PROTOCOL_TIMEOUT|TARGET_CRASHED|[A-Z_]{6,})/.exec(raw)?.[1];
  if (status === 400 && lh && lh !== "INVALID_ARGUMENT") return { code: "lighthouse_failed", message: `Lighthouse could not test the page (${lh}).` };
  if (status === 400) return { code: "lighthouse_failed", message: "PageSpeed Insights rejected the request for this URL." };
  if (status === 401 || status === 403) return { code: "auth_failed", message: "The PageSpeed Insights API key was rejected or the API is not enabled for it." };
  if (status === 429) return /quota/i.test(raw) ? { code: "quota_exhausted", message: "The PageSpeed Insights daily quota is used up." } : { code: "rate_limited", message: "PageSpeed Insights is rate-limiting requests. Try again later." };
  if (status >= 500 && lh) return { code: "lighthouse_failed", message: `Lighthouse could not test the page (${lh}).` };
  return { code: "provider_unavailable", message: `PageSpeed Insights is unavailable (HTTP ${status}).` };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, max = 300): string | null => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : null);

const FIELD_CAT: Record<string, FieldCategory> = { FAST: "good", AVERAGE: "needs_improvement", SLOW: "poor" };

function fieldMetric(metrics: Obj | null, key: string, divisor = 1): FieldMetric | null {
  const m = obj(metrics?.[key]);
  const p = num(m?.percentile);
  const c = FIELD_CAT[String(m?.category ?? "")];
  if (p === null || !c) return null;
  return { p75: p / divisor, category: c };
}

function fieldBlock(le: Obj | null, scope: "url" | "origin"): PerformanceRun["field"] {
  const metrics = obj(le?.metrics);
  if (!metrics || Object.keys(metrics).length === 0) return null;
  const out = {
    scope,
    overall: FIELD_CAT[String(le?.overall_category ?? "")] ?? null,
    lcp: fieldMetric(metrics, "LARGEST_CONTENTFUL_PAINT_MS"),
    inp: fieldMetric(metrics, "INTERACTION_TO_NEXT_PAINT"),
    // CrUX reports CLS percentile multiplied by 100.
    cls: fieldMetric(metrics, "CUMULATIVE_LAYOUT_SHIFT_SCORE", 100),
    fcp: fieldMetric(metrics, "FIRST_CONTENTFUL_PAINT_MS"),
    ttfb: fieldMetric(metrics, "EXPERIMENTAL_TIME_TO_FIRST_BYTE"),
  };
  return out.lcp || out.inp || out.cls || out.fcp || out.ttfb ? out : null;
}

export function parsePageSpeed(body: Obj, url: string, strategy: Strategy): PerformanceRun {
  const lr = obj(body.lighthouseResult);
  if (!lr) throw new Error("missing lighthouseResult");
  const audits = obj(lr.audits) ?? {};
  const audit = (id: string) => obj(audits[id]);
  const numeric = (id: string) => num(audit(id)?.numericValue);
  const perfScore = num(obj(obj(lr.categories)?.performance)?.score);
  const run = emptyRun(url, strategy, null);
  run.ok = true;
  run.finalUrl = text(lr.finalDisplayedUrl, 2048) ?? text(lr.finalUrl, 2048) ?? text(body.id, 2048);
  run.fetchedAt = text(lr.fetchTime, 40) ?? text(body.analysisUTCTimestamp, 40) ?? run.fetchedAt;
  run.lighthouseVersion = text(lr.lighthouseVersion, 20);
  run.score = perfScore === null ? null : Math.round(perfScore * 100);
  run.lab = {
    fcpMs: numeric("first-contentful-paint"),
    lcpMs: numeric("largest-contentful-paint"),
    tbtMs: numeric("total-blocking-time"),
    cls: numeric("cumulative-layout-shift"),
    speedIndexMs: numeric("speed-index"),
  };

  // Field data: prefer URL-level; fall back to origin-level and say so.
  const le = obj(body.loadingExperience);
  const originFallback = le?.origin_fallback === true;
  run.field = fieldBlock(le, originFallback ? "origin" : "url") ?? fieldBlock(obj(body.originLoadingExperience), "origin");

  // Resources (audit ids differ between Lighthouse versions; try both).
  const itemsOf = (id: string) => (Array.isArray(obj(audit(id)?.details)?.items) ? (obj(audit(id)?.details)!.items as unknown[]) : null);
  run.resources.totalBytes = numeric("total-byte-weight");
  run.resources.requestCount = itemsOf("network-requests")?.length ?? null;
  const rb = itemsOf("render-blocking-resources") ?? itemsOf("render-blocking-insight");
  run.resources.renderBlocking = (rb ?? [])
    .map((i) => obj(i))
    .filter((i): i is Obj => !!i && typeof i.url === "string")
    .slice(0, 10)
    .map((i) => ({ url: text(i.url, 2048)!, wastedMs: num(i.wastedMs) }));
  const savingsBytes = (id: string) => num(obj(audit(id)?.details)?.overallSavingsBytes);
  run.resources.unusedJsBytes = savingsBytes("unused-javascript");
  const img = [savingsBytes("uses-optimized-images"), savingsBytes("modern-image-formats"), savingsBytes("uses-responsive-images"), savingsBytes("image-delivery-insight")].filter((x): x is number => x !== null);
  run.resources.imageSavingsBytes = img.length ? Math.max(...img) : null;
  const cache = itemsOf("uses-long-cache-ttl") ?? itemsOf("cache-insight");
  run.resources.cacheIssues = cache ? cache.length : null;

  // Opportunities: failing audits that estimate time or byte savings.
  const opps: PerformanceRun["opportunities"] = [];
  for (const [id, raw] of Object.entries(audits)) {
    const a = obj(raw);
    if (!a) continue;
    const score = num(a.score);
    if (score === null || score >= 0.9) continue;
    const d = obj(a.details);
    const ms = num(d?.overallSavingsMs) ?? num(obj(a.metricSavings)?.LCP) ?? num(obj(a.metricSavings)?.FCP);
    const bytes = num(d?.overallSavingsBytes);
    if (!(ms && ms > 0) && !(bytes && bytes > 0)) continue;
    opps.push({ id: id.slice(0, 80), title: text(a.title, 200) ?? id, savingsMs: ms && ms > 0 ? Math.round(ms) : null, savingsBytes: bytes && bytes > 0 ? Math.round(bytes) : null, displayValue: text(a.displayValue, 120) });
  }
  opps.sort((a, b) => (b.savingsMs ?? 0) - (a.savingsMs ?? 0) || (b.savingsBytes ?? 0) - (a.savingsBytes ?? 0));
  run.opportunities = opps.slice(0, 10);

  const warnings = Array.isArray(lr.runWarnings) ? (lr.runWarnings as unknown[]).map((w) => text(w, 300)).filter((w): w is string => !!w) : [];
  run.warnings = warnings.slice(0, 5);
  if (perfScore === null) run.warnings.push("Lighthouse did not produce a performance score for this run.");
  return run;
}
