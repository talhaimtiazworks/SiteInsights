import { CATEGORY_LABELS, SEVERITY_ORDER, type Finding, type FindingCategory, type Severity } from "../audit/types";
import type { Prospect, ProspectEvidence } from "../db/commerce-types";

/**
 * Lead-generation helpers. Everything here is DETERMINISTIC and built only
 * from verified scanner output (findings with evidence, summary counts). No
 * AI, no invented data: each talking point links back to the finding and
 * URLs it came from, so a user can check it before contacting anyone.
 */

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 10, high: 6, medium: 3, low: 1.5, info: 0.5 };
const TYPE_WEIGHT: Record<Finding["type"], number> = { error: 1, recommendation: 0.6, observation: 0.25 };
/** Issues a site owner (not only a developer) notices or can be shown easily rank slightly higher. */
const CATEGORY_WEIGHT: Record<FindingCategory, number> = { links: 1.25, seo: 1.15, indexability: 1.15, security: 1.1, performance: 1.05, accessibility: 1, browser: 1 };

/** Why the category matters to the site's owner — general, factual statements (not claims about this site). */
export const CATEGORY_IMPACT: Record<FindingCategory, string> = {
  links: "Broken links send visitors and search engine crawlers to dead ends.",
  seo: "Missing or duplicated titles and descriptions weaken how pages appear in search results.",
  indexability: "Crawling and indexing problems can keep pages out of search results entirely.",
  security: "HTTPS and security header gaps can trigger browser warnings and reduce trust.",
  performance: "Slow pages are more likely to be abandoned, especially on mobile.",
  accessibility: "Accessibility barriers exclude some visitors and can create legal exposure.",
  browser: "Rendering problems mean some visitors see a broken or incomplete page.",
};

export function opportunityScore(f: Pick<Finding, "severity" | "type" | "category" | "affectedCount">): number {
  const reach = 1 + Math.log2(1 + Math.max(1, f.affectedCount));
  return Math.round(SEVERITY_WEIGHT[f.severity] * TYPE_WEIGHT[f.type] * CATEGORY_WEIGHT[f.category] * reach * 10) / 10;
}

export const OPPORTUNITY_FORMULA = "severity weight × finding type weight × category weight × (1 + log2(1 + affected pages)). Errors outrank recommendations; observations rank lowest.";

export function rankByOpportunity<T extends Pick<Finding, "severity" | "type" | "category" | "affectedCount" | "title">>(findings: T[]): Array<T & { opportunity: number }> {
  return findings
    .map((f) => ({ ...f, opportunity: opportunityScore(f) }))
    .sort((a, b) => b.opportunity - a.opportunity || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.title.localeCompare(b.title));
}

interface SummaryLike {
  pagesScanned: number;
  brokenLinks: number;
  findingsBySeverity: Record<string, number>;
  totalFindings: number;
  scores?: Partial<Record<FindingCategory, number | null>>;
}

export function buildProspectEvidence(scan: { status: string; overallScore?: number | null; summary: SummaryLike | null }, findings: Finding[]): ProspectEvidence {
  const open = findings.filter((f) => f.resolution?.status !== "ignored");
  return {
    overallScore: scan.overallScore ?? null,
    pagesScanned: scan.summary?.pagesScanned ?? 0,
    brokenLinks: scan.summary?.brokenLinks ?? 0,
    findingsBySeverity: { ...(scan.summary?.findingsBySeverity ?? {}) },
    totalFindings: scan.summary?.totalFindings ?? open.length,
    topIssues: rankByOpportunity(open.filter((f) => f.type !== "observation"))
      .slice(0, 5)
      .map((f) => ({ title: f.title.slice(0, 200), severity: f.severity, affectedCount: f.affectedCount })),
    auditStatus: scan.status,
  };
}

export interface TalkingPoint {
  findingId: string;
  title: string;
  category: FindingCategory;
  categoryLabel: string;
  severity: Severity;
  type: Finding["type"];
  affectedCount: number;
  /** What the scanner observed (verbatim evidence summary). */
  evidence: string;
  exampleUrls: string[];
  impact: string;
  recommendation: string;
  opportunity: number;
}

export interface OpportunityBrief {
  /** One neutral sentence summarising verified results. */
  headline: string;
  talkingPoints: TalkingPoint[];
  /** Categories that scored well — useful for a positive, credible conversation. */
  strengths: Array<{ category: FindingCategory; label: string; score: number }>;
  /** True when few actionable issues were found. */
  lowIssueSite: boolean;
  /** What a user should say/keep in mind; always shown with the brief. */
  caveats: string[];
}

export function buildOpportunityBrief(scan: { targetUrl: string; status: string; summary: SummaryLike | null; limits?: { maxPages: number } }, findings: Finding[]): OpportunityBrief {
  const host = safeHost(scan.targetUrl);
  const actionable = findings.filter((f) => f.type !== "observation" && f.resolution?.status !== "ignored");
  const ranked = rankByOpportunity(actionable);
  const pages = scan.summary?.pagesScanned ?? 0;
  const serious = actionable.filter((f) => f.severity === "critical" || f.severity === "high").length;
  const talkingPoints = ranked.slice(0, 5).map(
    (f): TalkingPoint => ({
      findingId: f.id,
      title: f.title,
      category: f.category,
      categoryLabel: CATEGORY_LABELS[f.category],
      severity: f.severity,
      type: f.type,
      affectedCount: f.affectedCount,
      evidence: f.evidence.summary,
      exampleUrls: (f.affectedUrls.length ? f.affectedUrls : [f.affectedUrl]).filter(Boolean).slice(0, 3),
      impact: CATEGORY_IMPACT[f.category],
      recommendation: f.recommendation,
      opportunity: f.opportunity,
    }),
  );
  const strengths = Object.entries(scan.summary?.scores ?? {})
    .filter((e): e is [FindingCategory, number] => typeof e[1] === "number" && e[1] >= 90)
    .map(([category, score]) => ({ category, label: CATEGORY_LABELS[category], score }))
    .sort((a, b) => b.score - a.score);
  const lowIssueSite = actionable.length <= 3 && serious === 0;
  const headline = lowIssueSite
    ? `${host}: ${pages} page${pages === 1 ? "" : "s"} checked, ${actionable.length} actionable issue${actionable.length === 1 ? "" : "s"} found. The site is in good technical shape; the points below are refinements, not urgent problems.`
    : `${host}: ${pages} page${pages === 1 ? "" : "s"} checked, ${actionable.length} actionable issue${actionable.length === 1 ? "" : "s"} found, ${serious} of them high or critical severity.`;
  const caveats = [
    "Every point comes from this automated audit and links to its evidence. Check it on the live site before you mention it — sites change.",
    `The audit covered ${pages} page${pages === 1 ? "" : "s"}${scan.limits ? ` (limit ${scan.limits.maxPages})` : ""}; pages outside that sample were not checked.`,
    "SiteInsights does not find contact details or send messages. Reach out only through channels the business publishes, and follow applicable anti-spam and privacy law.",
  ];
  if (lowIssueSite) caveats.push("With few issues, lead with what works well and offer a maintenance or monitoring check rather than a fix list.");
  return { headline, talkingPoints, strengths, lowIssueSite, caveats };
}

function safeHost(u: string) {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
}

// ── CSV export (manual outreach; never automated) ──

/**
 * RFC 4180 quoting plus spreadsheet formula-injection protection: cells that
 * begin with = + - @ TAB or CR are prefixed with an apostrophe so spreadsheet
 * apps treat them as text.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  s = s.replace(/\r\n?/g, "\n");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export const PROSPECT_CSV_COLUMNS = ["Website", "Hostname", "Business name", "Location", "Status", "Audit date", "Overall score", "Pages scanned", "Broken links", "Critical", "High", "Medium", "Top verified issues", "Contact name", "Contact email", "Contact page", "Notes", "Report link"] as const;

export function prospectsToCsv(prospects: Prospect[], reportUrl: (p: Prospect) => string | null): string {
  const rows: string[][] = [[...PROSPECT_CSV_COLUMNS]];
  for (const p of prospects) {
    const e = p.evidence;
    rows.push([
      p.websiteUrl,
      p.hostname,
      p.businessName ?? "",
      p.location ?? "",
      p.status,
      p.auditedAt ? p.auditedAt.slice(0, 10) : "",
      e?.overallScore ?? "",
      e?.pagesScanned ?? "",
      e?.brokenLinks ?? "",
      e?.findingsBySeverity.critical ?? 0,
      e?.findingsBySeverity.high ?? 0,
      e?.findingsBySeverity.medium ?? 0,
      (e?.topIssues ?? []).map((t) => `${t.title} (${t.severity}, ${t.affectedCount})`).join("; "),
      p.contactName ?? "",
      p.contactEmail ?? "",
      p.contactUrl ?? "",
      p.notes ?? "",
      reportUrl(p) ?? "",
    ].map(String));
  }
  // BOM so spreadsheet apps detect UTF-8.
  return "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
