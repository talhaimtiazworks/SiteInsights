import { SEVERITY_ORDER, type Finding } from "../audit/types";
import type { ScanSummary } from "../scanner/types";

/**
 * Report summaries shared by the web report and the PDF export, so both
 * describe coverage and priorities identically.
 */

/** Minimal scan shape needed for coverage (satisfied by PublicScan and ScanJob). */
export interface CoverageInput {
  scan: { summary: ScanSummary | null; crawl: { crawlTruncated: boolean } };
}

export const ACCESSIBILITY_DISCLAIMER =
  "Automated tests (axe-core and HTML checks) find only part of all accessibility barriers. These results do not establish WCAG conformance or legal compliance; manual testing with assistive technology is still needed.";

// ------------------------------------------------------------------ coverage
export type CoverageRow = { label: string; state: "done" | "partial" | "skipped"; detail: string };

/** Reasons are stored as sentences; trims the final period so they can be embedded. */
export const clause = (r: string | null | undefined) => {
  const c = (r ?? "").trim().replace(/\.+$/, "");
  // Lower-case the first letter for mid-sentence use, but keep acronyms ("PageSpeed", "URL").
  return c.length > 1 && /^[A-Z][a-z]/.test(c) && !/^[A-Z][a-z]+[A-Z]/.test(c.split(" ")[0]) ? c[0].toLowerCase() + c.slice(1) : c;
};
/** Formats a stored reason as one capitalised sentence ending in a period. */
export const sentence = (r: string | null | undefined) => {
  const c = clause(r);
  return c ? `${c[0].toUpperCase()}${c.slice(1)}.` : "";
};

export function coverageRows(data: CoverageInput): CoverageRow[] {
  const s = data.scan.summary!;
  const cov = s.coverage;
  const rows: CoverageRow[] = [
    { label: "HTML crawl", state: data.scan.crawl.crawlTruncated ? "partial" : "done", detail: `${s.pagesScanned} URLs fetched, ${s.htmlPages} HTML pages analysed${data.scan.crawl.crawlTruncated ? " — limits reached, not every discovered URL was crawled" : ""}` },
    { label: "Link checks", state: s.inconclusiveLinks > 0 ? "partial" : "done", detail: `${s.linksChecked} destinations checked${s.inconclusiveLinks ? `, ${s.inconclusiveLinks} could not be verified` : ""}` },
  ];
  if (!cov) {
    rows.push({ label: "Browser rendering", state: "skipped", detail: "Not evaluated (this audit predates browser checks)" });
    rows.push({ label: "Accessibility (axe-core)", state: "skipped", detail: "Not evaluated" });
    rows.push({ label: "Performance", state: "skipped", detail: "Not evaluated" });
    return rows;
  }
  const b = cov.browser;
  rows.push(
    b.attempted === 0
      ? { label: "Browser rendering", state: "skipped", detail: `Not evaluated — ${clause(b.skippedReason) || "not requested"}` }
      : { label: "Browser rendering", state: b.failed > 0 || b.succeeded < b.requested ? "partial" : "done", detail: `${b.succeeded} of ${b.requested} planned page(s) rendered in Chromium (mobile viewport)${b.failed ? `, ${b.failed} failed to render` : ""}${b.skippedReason ? ` — ${clause(b.skippedReason)}` : ""}` },
  );
  const a = cov.accessibility;
  rows.push(
    a.pages === 0
      ? { label: "Accessibility (axe-core)", state: "skipped", detail: `Not evaluated — ${clause(a.skippedReason) || "not requested"}. Static HTML accessibility checks still ran.` }
      : { label: "Accessibility (axe-core)", state: a.skippedReason ? "partial" : "done", detail: `${a.pages} page(s) tested with ${a.engine ?? "axe-core"}${a.skippedReason ? ` — ${clause(a.skippedReason)}` : ""}` },
  );
  const p = cov.performance;
  const okRuns = p.runs.filter((r) => r.ok);
  rows.push(
    p.runs.length === 0
      ? { label: "Performance", state: "skipped", detail: `Not evaluated — ${clause(p.skippedReason) || "not requested"}` }
      : { label: "Performance", state: okRuns.length === p.runs.length ? "done" : okRuns.length ? "partial" : "skipped", detail: `${p.runs.map((r) => `${r.strategy}: ${r.ok ? "tested" : `failed (${r.error ?? "error"})`}`).join("; ")}${p.url ? ` — start page only` : ""}` },
  );
  return rows;
}

export function priorityFindings<F extends Pick<Finding, "type" | "severity" | "affectedCount">>(findings: F[], max = 6): F[] {
  return findings
    .filter((f) => f.type !== "observation" && SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER.medium)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.type === "error" ? 0 : 1) - (b.type === "error" ? 0 : 1) || b.affectedCount - a.affectedCount)
    .slice(0, max);
}

