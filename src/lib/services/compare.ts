import "server-only";
import { computeOverallScore, deriveMetrics, scoredCategories, type AuditMetric } from "../audit/metrics";
import { CATEGORIES, CATEGORY_LABELS, SEVERITY_ORDER, type Finding } from "../audit/types";
import type { Repository } from "../db/types";
import type { PerformanceRun } from "../performance/pagespeed";
import { BROKEN_CATEGORIES, type ScanJob } from "../scanner/types";

export type CompareStatus = "compared" | "not_evaluated_in_baseline" | "not_evaluated_in_latest" | "not_evaluated";

interface Side {
  id: string;
  title: string | null;
  targetUrl: string;
  hostname: string;
  createdAt: string;
  status: ScanJob["status"];
  pagesScanned: number | null;
  checks: { browserPages: number; accessibility: boolean; performance: string[] };
}

const MAX_LIST = 50;
const side = (s: ScanJob): Side => ({
  id: s.id,
  title: s.title ?? null,
  targetUrl: s.targetUrl,
  hostname: s.hostname,
  createdAt: s.createdAt,
  status: s.status,
  pagesScanned: s.summary?.pagesScanned ?? null,
  checks: { browserPages: s.limits.browserPages ?? 0, accessibility: !!s.limits.accessibility, performance: s.limits.performanceStrategies ?? [] },
});

function pair(a: number | null | undefined, b: number | null | undefined) {
  const av = typeof a === "number" ? a : null;
  const bv = typeof b === "number" ? b : null;
  const status: CompareStatus = av === null && bv === null ? "not_evaluated" : av === null ? "not_evaluated_in_baseline" : bv === null ? "not_evaluated_in_latest" : "compared";
  return { baseline: av, latest: bv, delta: status === "compared" ? Math.round(((bv as number) - (av as number)) * 1000) / 1000 : null, status };
}

const issueKey = (f: Finding) => `${f.ruleId}|${f.affectedUrl}`;
const brief = (f: Finding) => ({ id: f.id, ruleId: f.ruleId, title: f.title, severity: f.severity, category: f.category, affectedUrl: f.affectedUrl });

/**
 * Compares two finished audits. The older one is the baseline. Nothing is
 * inferred: values missing on either side are reported as not evaluated /
 * unavailable, and differences in site or checks are flagged.
 */
export async function compareAudits(repo: Repository, x: ScanJob, y: ScanJob) {
  const [base, latest] = x.createdAt <= y.createdAt ? [x, y] : [y, x];
  const [fa, fb, la, lb, pa, pb] = await Promise.all([
    repo.listFindings(base.id),
    repo.listFindings(latest.id),
    repo.listLinkChecks(base.id),
    repo.listLinkChecks(latest.id),
    repo.listArtifacts(base.id, "performance"),
    repo.listArtifacts(latest.id, "performance"),
  ]);

  const notes: string[] = [];
  const sameSite = base.hostname === latest.hostname;
  if (!sameSite) notes.push(`These audits are of different sites (${base.hostname} and ${latest.hostname}); differences are not like-for-like.`);
  const catsA = scoredCategories(base.summary).join(",");
  const catsB = scoredCategories(latest.summary).join(",");
  const sameCategories = catsA === catsB;
  if (!sameCategories) notes.push("Different categories were evaluated, so the overall scores are not directly comparable. Compare individual categories instead.");
  const formulaSame = base.summary?.scoreFormulaVersion === latest.summary?.scoreFormulaVersion;
  if (!formulaSame) notes.push(`The scoring formula changed between these audits (${base.summary?.scoreFormulaVersion ?? "unknown"} → ${latest.summary?.scoreFormulaVersion ?? "unknown"}).`);
  if ((base.summary?.pagesScanned ?? 0) !== (latest.summary?.pagesScanned ?? 0)) notes.push(`A different number of pages was scanned (${base.summary?.pagesScanned ?? 0} vs ${latest.summary?.pagesScanned ?? 0}); issue counts can change for that reason alone.`);

  const overall = pair(computeOverallScore(base.summary), computeOverallScore(latest.summary));
  const categories = [...CATEGORIES].map((c) => ({ category: c, label: CATEGORY_LABELS[c], ...pair(base.summary?.scores?.[c], latest.summary?.scores?.[c]) }));

  const mapA = new Map(fa.map((f) => [issueKey(f), f]));
  const mapB = new Map(fb.map((f) => [issueKey(f), f]));
  const bySev = (p: Finding, q: Finding) => SEVERITY_ORDER[p.severity] - SEVERITY_ORDER[q.severity] || p.title.localeCompare(q.title);
  const added = fb.filter((f) => !mapA.has(issueKey(f))).sort(bySev);
  const fixed = fa.filter((f) => !mapB.has(issueKey(f))).sort(bySev);
  const persisting = fb.filter((f) => mapA.has(issueKey(f))).length;
  const severity = (["critical", "high", "medium", "low", "info"] as const).map((sev) => ({ severity: sev, ...pair(base.summary?.findingsBySeverity?.[sev] ?? fa.filter((f) => f.severity === sev).length, latest.summary?.findingsBySeverity?.[sev] ?? fb.filter((f) => f.severity === sev).length) }));

  const broken = (links: typeof la) => new Set(links.filter((l) => BROKEN_CATEGORIES.includes(l.category)).map((l) => l.url));
  const checked = (links: typeof la) => new Set(links.map((l) => l.url));
  const ba = broken(la);
  const bb = broken(lb);
  const cb = checked(lb);
  const ca = checked(la);
  const newlyBroken = [...bb].filter((u) => !ba.has(u));
  // "Fixed" only when the same URL was checked again and is no longer broken (not merely absent).
  const fixedLinks = [...ba].filter((u) => !bb.has(u) && cb.has(u));
  const noLongerChecked = [...ba].filter((u) => !cb.has(u)).length;
  const newlyChecked = [...cb].filter((u) => !ca.has(u)).length;

  const ma = new Map<string, AuditMetric>(deriveMetrics(base.summary, pa.map((a) => a.data as PerformanceRun)).filter((m) => m.source === "pagespeed_lab" || m.source === "crux_field").map((m) => [m.key, m]));
  const mb = new Map<string, AuditMetric>(deriveMetrics(latest.summary, pb.map((a) => a.data as PerformanceRun)).filter((m) => m.source === "pagespeed_lab" || m.source === "crux_field").map((m) => [m.key, m]));
  const metricKeys = [...new Set([...ma.keys(), ...mb.keys()])].sort();
  const metrics = metricKeys.map((k) => {
    const m = (ma.get(k) ?? mb.get(k))!;
    const p = pair(ma.get(k)?.value, mb.get(k)?.value);
    return { key: k, metric: m.metric, unit: m.unit, source: m.source, strategy: (m.context.strategy as string) ?? null, ...p, status: p.status === "compared" ? p.status : p.status.replace("not_evaluated", "unavailable") };
  });
  const perfRequested = (s: ScanJob) => (s.limits.performanceStrategies ?? []).length > 0;
  if (!metrics.length) notes.push(perfRequested(base) || perfRequested(latest) ? "Performance data is unavailable for at least one of these audits (the PageSpeed test did not return results)." : "Performance was not tested in either audit, so no performance metrics can be compared.");

  return {
    baseline: side(base),
    latest: side(latest),
    comparable: { sameSite, sameCategories, sameFormula: formulaSame, notes },
    overall,
    categories,
    severity,
    issues: {
      baselineTotal: fa.length,
      latestTotal: fb.length,
      added: added.slice(0, MAX_LIST).map(brief),
      addedCount: added.length,
      fixed: fixed.slice(0, MAX_LIST).map(brief),
      fixedCount: fixed.length,
      persisting,
    },
    links: {
      checked: pair(base.summary?.linksChecked, latest.summary?.linksChecked),
      broken: pair(base.summary?.brokenLinks, latest.summary?.brokenLinks),
      inconclusive: pair(base.summary?.inconclusiveLinks, latest.summary?.inconclusiveLinks),
      newlyBroken: newlyBroken.slice(0, MAX_LIST),
      newlyBrokenCount: newlyBroken.length,
      fixed: fixedLinks.slice(0, MAX_LIST),
      fixedCount: fixedLinks.length,
      noLongerChecked,
      newlyChecked,
    },
    metrics,
  };
}
export type AuditComparison = Awaited<ReturnType<typeof compareAudits>>;
