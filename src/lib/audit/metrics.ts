import type { PerformanceRun } from "../performance/pagespeed";
import type { ScanSummary } from "../scanner/types";

/**
 * Overall site-health score: the mean of the SiteInsights category scores that
 * were actually evaluated (categories marked "Not evaluated" are excluded).
 * Google's Lighthouse performance score is reported separately and is not
 * blended in, so audits with and without PageSpeed stay comparable.
 * Returns null when no category could be scored.
 */
export function computeOverallScore(summary: Pick<ScanSummary, "scores"> | null | undefined): number | null {
  if (!summary?.scores) return null;
  const vals = Object.entries(summary.scores)
    .filter(([k, v]) => k !== "performance" && typeof v === "number" && Number.isFinite(v))
    .map(([, v]) => v as number);
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/** Categories that contributed to the overall score (for comparability checks). */
export function scoredCategories(summary: Pick<ScanSummary, "scores"> | null | undefined): string[] {
  if (!summary?.scores) return [];
  return Object.entries(summary.scores)
    .filter(([k, v]) => k !== "performance" && typeof v === "number")
    .map(([k]) => k)
    .sort();
}

export type MetricSource = "sitelens_rules" | "crawler" | "link_checker" | "pagespeed_lab" | "crux_field" | "axe_core";

export interface AuditMetric {
  /** Unique within an audit, e.g. "score:seo", "pagespeed:mobile:lab:lcp". */
  key: string;
  metric: string;
  category: string;
  value: number | null;
  unit: "score" | "count" | "ms" | "unitless" | "bytes";
  source: MetricSource;
  context: Record<string, string | number | boolean | null>;
}

const LAB: Array<[keyof PerformanceRun["lab"], string, AuditMetric["unit"]]> = [
  ["fcpMs", "first_contentful_paint", "ms"],
  ["lcpMs", "largest_contentful_paint", "ms"],
  ["tbtMs", "total_blocking_time", "ms"],
  ["cls", "cumulative_layout_shift", "unitless"],
  ["speedIndexMs", "speed_index", "ms"],
];
const FIELD: Array<["lcp" | "inp" | "cls" | "fcp" | "ttfb", string, AuditMetric["unit"]]> = [
  ["lcp", "largest_contentful_paint", "ms"],
  ["inp", "interaction_to_next_paint", "ms"],
  ["cls", "cumulative_layout_shift", "unitless"],
  ["fcp", "first_contentful_paint", "ms"],
  ["ttfb", "time_to_first_byte", "ms"],
];

/**
 * Flattens a finished audit into named, source-attributed metrics. Only
 * values that were actually measured are emitted — nothing is estimated.
 * Lab metrics (Lighthouse) and field metrics (Chrome UX Report) are kept
 * apart; INP only ever comes from field data.
 */
export function deriveMetrics(summary: ScanSummary | null, performance: PerformanceRun[]): AuditMetric[] {
  const out: AuditMetric[] = [];
  if (summary) {
    for (const [cat, v] of Object.entries(summary.scores ?? {})) {
      if (typeof v === "number") out.push({ key: `score:${cat}`, metric: "category_score", category: cat, value: v, unit: "score", source: cat === "performance" ? "pagespeed_lab" : "sitelens_rules", context: { formula: summary.scoreFormulaVersion } });
    }
    const overall = computeOverallScore(summary);
    if (overall !== null) out.push({ key: "score:overall", metric: "overall_score", category: "overall", value: overall, unit: "score", source: "sitelens_rules", context: { categories: scoredCategories(summary).join(",") } });
    out.push({ key: "count:pages_scanned", metric: "pages_scanned", category: "crawl", value: summary.pagesScanned, unit: "count", source: "crawler", context: { truncated: summary.crawlTruncated } });
    out.push({ key: "count:links_checked", metric: "links_checked", category: "links", value: summary.linksChecked, unit: "count", source: "link_checker", context: {} });
    out.push({ key: "count:broken_links", metric: "broken_links", category: "links", value: summary.brokenLinks, unit: "count", source: "link_checker", context: {} });
    out.push({ key: "count:inconclusive_links", metric: "inconclusive_links", category: "links", value: summary.inconclusiveLinks, unit: "count", source: "link_checker", context: {} });
    out.push({ key: "count:issues_total", metric: "issues_total", category: "issues", value: summary.totalFindings, unit: "count", source: "sitelens_rules", context: {} });
    for (const [sev, n] of Object.entries(summary.findingsBySeverity ?? {})) {
      out.push({ key: `count:issues:${sev}`, metric: "issues_by_severity", category: "issues", value: n, unit: "count", source: "sitelens_rules", context: { severity: sev } });
    }
    const a11y = summary.coverage?.accessibility;
    if (a11y && a11y.pages > 0) out.push({ key: "count:accessibility_pages", metric: "accessibility_pages_tested", category: "accessibility", value: a11y.pages, unit: "count", source: "axe_core", context: { engine: a11y.engine } });
  }
  for (const run of performance) {
    if (!run.ok) continue;
    const ctx = { strategy: run.strategy, url: run.finalUrl ?? run.url, lighthouse: run.lighthouseVersion };
    if (typeof run.score === "number") out.push({ key: `pagespeed:${run.strategy}:score`, metric: "lighthouse_performance_score", category: "performance", value: run.score, unit: "score", source: "pagespeed_lab", context: ctx });
    for (const [k, name, unit] of LAB) {
      const v = run.lab[k];
      if (typeof v === "number") out.push({ key: `pagespeed:${run.strategy}:lab:${name}`, metric: name, category: "performance", value: v, unit, source: "pagespeed_lab", context: ctx });
    }
    if (run.field) {
      for (const [k, name, unit] of FIELD) {
        const m = run.field[k];
        if (m) out.push({ key: `pagespeed:${run.strategy}:field:${name}`, metric: name, category: "performance", value: m.p75, unit, source: "crux_field", context: { ...ctx, scope: run.field.scope, percentile: 75, rating: m.category } });
      }
    }
  }
  return out;
}
