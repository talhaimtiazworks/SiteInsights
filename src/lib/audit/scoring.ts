import { CATEGORIES, SEVERITY_ORDER, type Finding, type FindingCategory, type Severity } from "./types";

/**
 * Category score formula (version v1) — documented on the Help page.
 *
 *   score(category) = max(0, round(100 − Σ P(rule)))   over rules triggered in the category
 *   P(rule) = W(s) × (0.5 + 0.5 × c)
 *     s = the highest severity among that rule's findings
 *     c = min(1, n / N), n = distinct affected URLs for the rule, N = HTML pages loaded
 *   W = { critical: 30, high: 15, medium: 7, low: 3, info: 0 }
 *
 * N is the number of pages the rule could evaluate: HTML pages loaded for
 * HTML-based rules, pages rendered in the browser for browser and axe-core
 * rules (v2).
 *
 * Performance is the exception: its score is the Lighthouse performance score
 * (lab, mobile preferred) reported by PageSpeed Insights, not this formula.
 *
 * A category that was not evaluated (e.g. no HTML pages, no links checked, no
 * browser worker, no PageSpeed key) has a null score and is shown as
 * "Not evaluated" — it never counts as 0 or 100. Scores summarise the findings
 * of THIS scan only; they are not predictions of search ranking.
 */
export const SCORE_FORMULA_VERSION = "v2";
export const SEVERITY_WEIGHTS: Record<Severity, number> = { critical: 30, high: 15, medium: 7, low: 3, info: 0 };

export function computeScores(findings: Finding[], htmlPages: number, evaluated: Partial<Record<FindingCategory, boolean>>, opts: { renderedPages?: number; performance?: number | null } = {}): Record<FindingCategory, number | null> {
  const out = {} as Record<FindingCategory, number | null>;
  const denominator = (ruleId: string) => Math.max(1, ruleId.startsWith("browser.") || ruleId.startsWith("accessibility.axe.") ? (opts.renderedPages ?? htmlPages) : htmlPages);
  for (const cat of CATEGORIES) {
    if (!evaluated[cat]) {
      out[cat] = null;
      continue;
    }
    if (cat === "performance") {
      out[cat] = opts.performance ?? null;
      continue;
    }
    const byRule = new Map<string, { sev: Severity; urls: Set<string> }>();
    for (const f of findings) {
      if (f.category !== cat) continue;
      const cur = byRule.get(f.ruleId) ?? { sev: f.severity, urls: new Set<string>() };
      if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[cur.sev]) cur.sev = f.severity;
      for (const u of f.affectedUrls) cur.urls.add(u);
      if (f.affectedUrls.length === 0) cur.urls.add(f.affectedUrl);
      byRule.set(f.ruleId, cur);
    }
    let penalty = 0;
    for (const [ruleId, { sev, urls }] of byRule) {
      const c = Math.min(1, urls.size / denominator(ruleId));
      penalty += SEVERITY_WEIGHTS[sev] * (0.5 + 0.5 * c);
    }
    out[cat] = Math.max(0, Math.round(100 - penalty));
  }
  return out;
}
