import type { FieldMetric, PerformanceRun } from "../performance/pagespeed";
import type { MakeFn } from "./analyze";
import { getRule } from "./rules";
import type { Severity } from "./types";

/**
 * Findings from PageSpeed Insights. Thresholds are the published Core Web
 * Vitals boundaries (good / needs improvement / poor). Lab and field data
 * are kept separate; INP is field-only and TBT is never presented as INP.
 */

export const LAB_THRESHOLDS = { lcpMs: [2500, 4000], cls: [0.1, 0.25], tbtMs: [200, 600] } as const;

const fmtMs = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const fmtBytes = (v: number) => (v >= 1_048_576 ? `${(v / 1_048_576).toFixed(1)} MB` : `${Math.round(v / 1024)} KB`);

function labSeverity(value: number | null, [ni, poor]: readonly [number, number]): Severity | null {
  if (value === null) return null;
  if (value > poor) return "medium";
  if (value > ni) return "low";
  return null;
}
function fieldSeverity(m: FieldMetric | null): Severity | null {
  if (!m) return null;
  return m.category === "poor" ? "medium" : m.category === "needs_improvement" ? "low" : null;
}

export function analyzePerformance(input: { make: MakeFn; runs: PerformanceRun[] }) {
  const { make } = input;
  for (const run of input.runs) {
    if (!run.ok) continue;
    const device = run.strategy === "mobile" ? "mobile" : "desktop";
    const labSource = { label: "Source", value: `Lighthouse ${run.lighthouseVersion ?? ""} lab test via PageSpeed Insights — simulated ${device} device and network`.replace(/\s+/g, " ") };
    const fieldSource = run.field ? { label: "Source", value: `Chrome UX Report (real Chrome users, 28-day 75th percentile, ${device}), ${run.field.scope === "origin" ? "origin-level data (whole site): this URL has too little traffic for URL-level data" : "URL-level data"}` } : null;
    const when = { label: "Tested at", value: run.fetchedAt };
    const tested = { label: "Tested URL", value: run.finalUrl ?? run.url };

    const lab: Array<[Parameters<MakeFn>[0], number | null, readonly [number, number], (v: number) => string]> = [
      ["performance.lab_lcp", run.lab.lcpMs, LAB_THRESHOLDS.lcpMs, fmtMs],
      ["performance.lab_cls", run.lab.cls, LAB_THRESHOLDS.cls, (v) => v.toFixed(2)],
      ["performance.lab_tbt", run.lab.tbtMs, LAB_THRESHOLDS.tbtMs, fmtMs],
    ];
    for (const [rule, value, th, fmt] of lab) {
      const sev = labSeverity(value, th);
      if (!sev || value === null) continue;
      make(rule, `${rule}:${run.strategy}`, {
        affectedUrls: [run.url],
        severity: sev,
        title: `${getRule(rule).title} — ${device}`,
        evidence: {
          summary: `Lab value ${fmt(value)} on ${device} (good ≤ ${fmt(th[0])}, poor > ${fmt(th[1])}).`,
          items: [{ label: "Measured (lab)", value: fmt(value) }, { label: "Rating", value: sev === "medium" ? "Poor" : "Needs improvement" }, { label: "Device", value: device }, labSource, tested, when],
        },
      });
    }

    if (run.field && fieldSource) {
      const field: Array<[Parameters<MakeFn>[0], FieldMetric | null, string, (v: number) => string]> = [
        ["performance.field_lcp", run.field.lcp, "LCP", fmtMs],
        ["performance.field_inp", run.field.inp, "INP", fmtMs],
        ["performance.field_cls", run.field.cls, "CLS", (v) => v.toFixed(2)],
      ];
      for (const [rule, m, name, fmt] of field) {
        const sev = fieldSeverity(m);
        if (!sev || !m) continue;
        make(rule, `${rule}:${run.strategy}`, {
          affectedUrls: [run.url],
          severity: sev,
          title: `${getRule(rule).title} — ${device}`,
          evidence: {
            summary: `Real-user ${name} at the 75th percentile is ${fmt(m.p75)} on ${device} (${m.category === "poor" ? "poor" : "needs improvement"}).`,
            items: [{ label: `Field ${name} (p75)`, value: fmt(m.p75) }, { label: "Rating", value: m.category.replace("_", " ") }, { label: "Device", value: device }, fieldSource, tested, when],
          },
        });
      }
    }

    const rb = run.resources.renderBlocking;
    const rbMs = rb.reduce((a, r) => a + (r.wastedMs ?? 0), 0);
    if (rb.length && rbMs >= 300) {
      make("performance.render_blocking", `rb:${run.strategy}`, {
        affectedUrls: [run.url],
        title: `Render-blocking resources — ${device}`,
        evidence: { summary: `${rb.length} render-blocking resource(s), estimated ${fmtMs(rbMs)} delay on ${device} (lab).`, items: [...rb.slice(0, 10).map((r) => ({ label: r.url.slice(0, 120), value: r.wastedMs !== null ? `~${fmtMs(r.wastedMs)}` : "—" })), labSource, when] },
      });
    }
    const bytes = run.resources.totalBytes;
    if (bytes !== null && bytes > 4 * 1_048_576) {
      make("performance.page_weight", `weight:${run.strategy}`, {
        affectedUrls: [run.url],
        title: `Heavy page — ${device}`,
        ctx: { count: Math.floor(bytes / 1_048_576) },
        evidence: {
          summary: `The page transferred ${fmtBytes(bytes)} on ${device} (lab).`,
          items: [
            { label: "Total transfer", value: fmtBytes(bytes) },
            ...(run.resources.requestCount !== null ? [{ label: "Requests", value: String(run.resources.requestCount) }] : []),
            ...(run.resources.unusedJsBytes ? [{ label: "Unused JavaScript (est.)", value: fmtBytes(run.resources.unusedJsBytes) }] : []),
            ...(run.resources.imageSavingsBytes ? [{ label: "Image savings (est.)", value: fmtBytes(run.resources.imageSavingsBytes) }] : []),
            labSource,
            when,
          ],
        },
      });
    }
    const opps = run.opportunities.filter((o) => (o.savingsMs ?? 0) >= 300 || (o.savingsBytes ?? 0) >= 100_000);
    if (opps.length) {
      make("performance.opportunities", `opps:${run.strategy}`, {
        affectedUrls: [run.url],
        title: `Lighthouse improvement opportunities — ${device}`,
        evidence: {
          summary: `${opps.length} optimisation(s) with estimated savings on ${device} (lab estimates).`,
          items: [...opps.slice(0, 8).map((o) => ({ label: o.title.slice(0, 120), value: [o.savingsMs ? `~${fmtMs(o.savingsMs)}` : null, o.savingsBytes ? `~${fmtBytes(o.savingsBytes)}` : null, o.displayValue].filter(Boolean).join(" · ") || "—" })), labSource, when],
        },
      });
    }
  }
}

/** Category score for performance: the Lighthouse lab score (mobile preferred). null = not evaluated. */
export function performanceScore(runs: PerformanceRun[]): { score: number | null; strategy: "mobile" | "desktop" | null } {
  const mobile = runs.find((r) => r.strategy === "mobile" && r.ok && r.score !== null);
  if (mobile) return { score: mobile.score, strategy: "mobile" };
  const desktop = runs.find((r) => r.strategy === "desktop" && r.ok && r.score !== null);
  return desktop ? { score: desktop.score, strategy: "desktop" } : { score: null, strategy: null };
}
