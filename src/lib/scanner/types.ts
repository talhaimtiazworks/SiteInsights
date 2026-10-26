import type { FetchErrorInfo, RedirectHop } from "../security/safe-fetch";

export const SCAN_STATUSES = ["queued", "running", "completed", "completed_with_warnings", "failed", "cancelled"] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const SCAN_PHASES = ["queued", "discovery", "crawling", "rendering", "checking_links", "performance", "analyzing", "finished"] as const;
export type ScanPhase = (typeof SCAN_PHASES)[number];

export interface ScanLimits {
  maxPages: number;
  /** Page limit chosen when the audit started (≤ plan limit); credits were reserved for it. Absent on older audits. */
  requestedPages?: number;
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
  maxQueryVariantsPerPath: number;
  maxSitemapFiles: number;
  maxSitemapUrls: number;
  /** Pages to render in a real browser (0 = browser rendering not used). Absent on older scans. */
  browserPages?: number;
  /** Run axe-core on rendered pages. */
  accessibility?: boolean;
  /** PageSpeed Insights strategies to run (empty = performance not tested). */
  performanceStrategies?: ("mobile" | "desktop")[];
  /** Per-call timeouts for the external services (fixed at scan creation). */
  browserTimeoutMs?: number;
  browserNavTimeoutMs?: number;
  performanceTimeoutMs?: number;
}

export interface ScanProgress {
  /** Unique pages that returned an HTTP response (redirects to an already-scanned URL are not counted again). */
  pagesCrawled: number;
  /** Page fetches that got no response (timeout, DNS, connection, TLS) after retries. Absent on older audits. */
  pagesFailed?: number;
  /** Scanned pages that answered with HTTP 4xx/5xx. */
  pagesHttpErrors?: number;
  /** Discovered internal URLs not crawled (robots.txt, page limit, depth, URL traps, duplicates). */
  pagesSkipped?: number;
  /** Queued URLs that will still be crawled within the page limit (0 once crawling ends). */
  pagesRemaining?: number;
  /** Page limit of this audit. */
  pagesLimit?: number;
  pagesDiscovered: number;
  pagesQueued: number;
  linksChecked: number;
  linksTotal: number;
  findings: number;
  recentUrls: string[];
  pagesRendered?: number;
  renderTotal?: number;
  performanceDone?: number;
  performanceTotal?: number;
}

export type DiscoverySource = "start" | "sitemap" | "link" | "canonical" | "redirect";

export interface FrontierItem {
  url: string;
  depth: number;
  via: DiscoverySource;
  source: string | null;
}

export interface RobotsInfo {
  status: "found" | "not_found" | "error" | "not_checked";
  url: string;
  httpStatus: number | null;
  body: string | null;
  crawlDelayMs: number | null;
  sitemaps: string[];
  error: string | null;
  /** RFC 9309: when robots.txt is unreachable (5xx), assume full disallow. */
  disallowAll: boolean;
}

export interface SitemapInfo {
  status: "found" | "not_found" | "error" | "not_checked";
  checked: Array<{ url: string; httpStatus: number | null; type: "urlset" | "index" | "invalid" | "error"; urlCount: number; error: string | null; declaredInRobots: boolean }>;
  pageUrls: string[];
  offHostUrls: number;
}

export interface ScanState {
  frontier: FrontierItem[];
  seen: string[];
  queryVariantCounts: Record<string, number>;
  allowedHosts: string[];
  robots: RobotsInfo | null;
  sitemap: SitemapInfo | null;
  linkTargets: LinkTarget[];
  linkCursor: number;
  linkTargetsBuilt: boolean;
  skipped: { robots: number; limit: number; traps: number; offHost: number; depth: number; duplicates?: number };
  /** Final URLs already processed (dedupes redirects to the same page). Absent on older audits. */
  processed?: string[];
  /** Fetches without any response. */
  failedFetches?: number;
  httpErrors?: number;
  crawlTruncated: boolean;
  durationExceeded: boolean;
  /** Browser rendering work queue (absent until the rendering phase starts). */
  render?: { queue: string[]; attempted: number; succeeded: number; failed: number; busyRetries: number; skippedReason: string | null; accessibilityPages: number };
  /** Performance (PageSpeed Insights) work queue. */
  performance?: { url: string; queue: ("mobile" | "desktop")[]; attempted: number; succeeded: number; skippedReason: string | null };
}

export interface LinkTarget {
  url: string;
  kind: "page_link" | "image";
  internal: boolean;
  sources: string[];
  occurrences: number;
  /** "browser" = the link only exists in the rendered DOM (added by JavaScript). */
  discoveredBy?: "html" | "browser";
}

export interface ScanError {
  code: string;
  message: string;
}

export interface ScanSummary {
  pagesScanned: number;
  htmlPages: number;
  linksChecked: number;
  brokenLinks: number;
  inconclusiveLinks: number;
  findingsBySeverity: Record<string, number>;
  findingsByCategory: Record<string, number>;
  totalFindings: number;
  scores: Record<string, number | null>;
  scoreFormulaVersion: string;
  robotsStatus: string;
  sitemapStatus: string;
  crawlTruncated: boolean;
  durationMs: number;
  /** What was (and wasn't) evaluated. Added in v0.2. */
  coverage?: ScanCoverage;
}

export interface ScanCoverage {
  browser: { requested: number; attempted: number; succeeded: number; failed: number; skippedReason: string | null };
  accessibility: { pages: number; engine: string | null; skippedReason: string | null };
  performance: { url: string | null; runs: Array<{ strategy: "mobile" | "desktop"; ok: boolean; error: string | null }>; skippedReason: string | null };
}

export interface ScanJob {
  id: string;
  principalId: string;
  websiteId: string | null;
  targetUrl: string;
  hostname: string;
  status: ScanStatus;
  phase: ScanPhase;
  limits: ScanLimits;
  progress: ScanProgress;
  state: ScanState;
  warnings: string[];
  error: ScanError | null;
  summary: ScanSummary | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  /** Server-only access data. Never sent to clients (see toPublicScan). */
  access?: ScanAccess;
  /** User-chosen name (null = show the hostname). */
  title?: string | null;
  /** The audit this one re-runs (same URL and checks). */
  rerunOf?: string | null;
  /** Organization the owner shared this audit with (members get read access). */
  organizationId?: string | null;
  /** Mean of evaluated SiteInsights category scores (see computeOverallScore). */
  overallScore?: number | null;
  /** Server-only: hashed IP of the creating request (for per-IP limits during background work). */
  ipHash?: string | null;
}

export interface ScanAccess {
  /** SHA-256 of the scan access key given to the creating browser (the key itself is never stored). */
  keyHash: string | null;
  /** Client-supplied Idempotency-Key used to de-duplicate retried "start scan" requests. */
  idempotencyKey: string | null;
}

export interface PageLink {
  url: string;
  internal: boolean;
  text: string;
  nofollow: boolean;
}

export interface PageImage {
  src: string | null;
  hasAlt: boolean;
  alt: string | null;
}

export interface HeadingInfo {
  level: number;
  text: string;
}

export interface PageRecord {
  id: string;
  scanId: string;
  url: string;
  finalUrl: string;
  statusCode: number | null;
  responseTimeMs: number;
  contentType: string | null;
  isHtml: boolean;
  depth: number;
  discoveredVia: DiscoverySource;
  sourceUrl: string | null;
  redirectChain: RedirectHop[];
  bodyTruncated: boolean;
  fetchError: FetchErrorInfo | null;
  offSiteRedirect: boolean;
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  metaDescriptionCount: number;
  h1: string[];
  headings: HeadingInfo[];
  canonicalRaw: string | null;
  canonical: string | null;
  canonicalCount: number;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  lang: string | null;
  internalLinkCount: number;
  externalLinkCount: number;
  links: PageLink[];
  invalidLinks: string[];
  imageCount: number;
  imagesMissingAlt: number;
  images: PageImage[];
  mixedContent: string[];
  /** Added in v0.2 — absent on pages crawled by older versions. */
  jsonLd?: Array<{ valid: boolean; error: string | null; types: string[]; missing: string[] }>;
  social?: Record<string, string>;
  hreflang?: Array<{ lang: string; href: string | null; raw: string }>;
  viewport?: string | null;
  wordCount?: number;
  contentHash?: string | null;
  fetchedAt: string;
}

export type LinkCategory =
  | "ok"
  | "redirect"
  | "not_found"
  | "client_error"
  | "server_error"
  | "blocked"
  | "dns_error"
  | "connection_error"
  | "tls_error"
  | "timeout"
  | "redirect_loop"
  | "too_many_redirects"
  | "invalid_url"
  | "unsafe_destination"
  | "skipped_robots"
  | "not_checked"
  | "inconclusive";

export type LinkVerification = "verified" | "inconclusive" | "not_checked";

export interface LinkCheckRecord {
  id: string;
  scanId: string;
  url: string;
  kind: "page_link" | "image";
  internal: boolean;
  sources: string[];
  occurrences: number;
  statusCode: number | null;
  finalUrl: string | null;
  redirectChain: RedirectHop[];
  category: LinkCategory;
  verification: LinkVerification;
  method: "HEAD" | "GET" | "HEAD+GET" | "crawl" | "none";
  message: string;
  responseTimeMs: number | null;
  checkedAt: string;
  discoveredBy?: "html" | "browser";
}

/** Categories that represent a confirmed defect a visitor would hit. */
export const BROKEN_CATEGORIES: LinkCategory[] = ["not_found", "server_error", "dns_error", "redirect_loop", "too_many_redirects", "invalid_url", "tls_error"];
export const INCONCLUSIVE_CATEGORIES: LinkCategory[] = ["blocked", "client_error", "connection_error", "timeout", "inconclusive"];
