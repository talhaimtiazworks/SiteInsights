"use client";

import Link from "next/link";
import { LogoMark } from "@/components/brand";
import { BRAND } from "@/lib/brand";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SeverityBadge, StatusBadge, TypeBadge, SEVERITY_STYLES } from "@/components/badges";
import { FeedbackInvite } from "@/components/feedback-invite";
import { Alert, Badge, Button, ButtonLink, Card, CardHeader, cn, EmptyState, Input, Select } from "@/components/ui";
import { CATEGORIES, CATEGORY_LABELS, SEVERITIES, SEVERITY_LABELS, type Severity } from "@/lib/audit/types";
import { api, ApiClientError } from "@/lib/client/api";
import { displayUrl, formatDateTime, formatDuration } from "@/lib/client/format";
import type { ClientFinding, LinkCheckRecord, ResultsResponse } from "@/lib/client/types";
import { BROKEN_CATEGORIES, INCONCLUSIVE_CATEGORIES } from "@/lib/scanner/types";
import { AuditOwnerActions } from "@/components/audit-owner-actions";
import { ScanAccessError } from "@/components/scan-access-error";
import { ReportSkeleton } from "@/components/skeletons";
import { AiSummaryPanel } from "./ai-summary-panel";
import { ActionPlan, CoverageCard, PdfButton, PerformanceTab, PrivateLinkButton, RenderingTab } from "./report-sections";
import { OpportunityPanel, ShareLinksPanel, useOpportunity } from "./client-work";

type Tab = "issues" | "pages" | "links" | "rendering" | "performance" | "crawl";

export function ResultsClient({ id }: { id: string }) {
  const [data, setData] = useState<ResultsResponse | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [tab, setTab] = useState<Tab>("issues");
  const opportunity = useOpportunity(id, !!data);
  const ranking = useMemo(() => (opportunity.state.kind === "ok" ? new Map(opportunity.state.data.ranking.map((r) => [r.findingId, r.opportunity])) : null), [opportunity.state]);

  const load = useCallback(() => {
    setError(null);
    api<ResultsResponse>(`/api/scans/${id}/results`).then(setData).catch(setError);
  }, [id]);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  if (error) {
    const pending = error.code === "results_unavailable" && (error.details?.status === "running" || error.details?.status === "queued");
    if (error.code === "results_unavailable") {
      return (
        <div className="container max-w-2xl py-16">
          <Alert tone={pending ? "info" : "warning"} title={pending ? "This audit is still running" : "No report for this audit"}>{error.message}</Alert>
          <div className="mt-6 flex gap-3">
            <ButtonLink href={`/scans/${id}/progress`}>{pending ? "View progress" : "View audit details"}</ButtonLink>
            <ButtonLink href="/dashboard" variant="outline">Dashboard</ButtonLink>
          </div>
        </div>
      );
    }
    return <ScanAccessError error={error} what="report" onRetry={load} />;
  }
  if (!data) return <ReportSkeleton />;

  const { scan } = data;
  const s = scan.summary!;
  const isOwner = !!scan.viewer?.canEdit && !scan.viewer?.viaOrganization;
  const download = () => {
    const blob = new Blob([JSON.stringify({ generator: BRAND.name, parentBrand: BRAND.parent, attribution: BRAND.attribution, exportedAt: new Date().toISOString(), ...data }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `siteinsight-${new URL(scan.targetUrl).hostname}-${scan.id.slice(0, 8)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="container space-y-6 py-10">
      <div className="hidden items-center gap-3 border-b pb-4 print:flex"><LogoMark className="h-16 w-16" /><div><p className="text-lg font-semibold">{BRAND.name}</p><p className="text-sm text-muted-foreground">Website audit report · {BRAND.attribution}</p></div></div>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground print:hidden"><Link href="/dashboard/audits" className="hover:underline">Audits</Link> / Report</p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="break-all text-2xl font-semibold tracking-tight sm:text-3xl">{scan.title || displayUrl(scan.targetUrl, 80)}</h1>
            <StatusBadge status={scan.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {scan.title ? <>{displayUrl(scan.targetUrl, 80)} · </> : null}Scanned {formatDateTime(scan.finishedAt)} · took {formatDuration(s.durationMs)} · <a href={scan.targetUrl} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline">open site ↗</a>
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2 print:hidden">
          <Button variant="outline" size="sm" onClick={download}>Download JSON</Button>
          <PrivateLinkButton scanId={scan.id} />
          <PdfButton scanId={scan.id} filename={`siteinsight-${new URL(scan.targetUrl).hostname}-${scan.id.slice(0, 8)}.pdf`} />
          <ButtonLink href="/audit/new" size="sm">New audit</ButtonLink>
        </div>
        <div className="flex basis-full flex-wrap items-center gap-2 print:hidden">
          <AuditOwnerActions scan={scan} onChanged={load} />
        </div>
      </div>

      {!scan.persistent ? <Alert tone="warning" className="print:hidden">This report is stored in temporary server memory (no database configured) and may disappear. Download the JSON to keep a copy.</Alert> : null}
      {scan.warnings.length ? (
        <Alert tone="warning" title="This audit completed with warnings">
          <ul className="list-disc pl-5">{scan.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </Alert>
      ) : null}

      {/* Overview numbers */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Pages scanned", s.pagesScanned, `${s.htmlPages} HTML pages loaded`],
          ["Links checked", s.linksChecked, `Incl. crawled pages · ${s.inconclusiveLinks} unverified`],
          ["Broken links", s.brokenLinks, "Confirmed, linked from crawled pages"],
          ["Findings", s.totalFindings, `${(s.findingsBySeverity.critical ?? 0) + (s.findingsBySeverity.high ?? 0)} critical or high`],
        ].map(([l, v, h]) => (
          <Card key={String(l)} className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{l}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{v}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{h}</p>
          </Card>
        ))}
      </div>

      {/* Scores */}
      <Card className="print-break">
        <CardHeader title="Category scores" description={<>Calculated with a documented, reproducible formula from this scan&apos;s findings. <Link href="/help#scoring" className="text-primary hover:underline">How scores work</Link></>} />
        <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          {CATEGORIES.map((c) => {
            const v = s.scores[c];
            const color = v === null || v === undefined ? "bg-muted" : v >= 90 ? "bg-success" : v >= 70 ? "bg-brand-amber" : "bg-danger";
            return (
              <div key={c}>
                <div className="flex items-baseline justify-between">
                  <span className="text-sm">{CATEGORY_LABELS[c]}</span>
                  <span className="text-lg font-semibold tabular-nums">{v ?? "—"}</span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-muted"><div className={cn("h-full rounded-full", color)} style={{ width: `${v ?? 0}%` }} /></div>
                {v === null || v === undefined ? <p className="mt-1 text-xs text-muted-foreground">Not evaluated</p> : <p className="mt-1 text-xs text-muted-foreground">{s.findingsByCategory[c] ?? 0} finding(s)</p>}
              </div>
            );
          })}
        </div>
      </Card>

      <CoverageCard data={data} />
      <ActionPlan scanId={scan.id} findings={data.findings} />

      <OpportunityPanel scanId={scan.id} state={opportunity.state} reload={opportunity.reload} isOwner={isOwner} />
      {isOwner ? <ShareLinksPanel scanId={scan.id} /> : null}

      <AiSummaryPanel scanId={scan.id} initial={data.aiSummary} findings={data.findings} />

      {/* Tabs */}
      <div className="border-b print:hidden" role="tablist" aria-label="Report sections">
        <div className="-mb-px flex gap-1 overflow-x-auto">
          {([
            ["issues", `Issues (${data.findings.length})`],
            ["pages", `Pages (${data.pages.length})`],
            ["links", `Links (${data.links.length})`],
            ["rendering", "Rendering & accessibility"],
            ["performance", "Performance"],
            ["crawl", "Crawl details"],
          ] as Array<[Tab, string]>).map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn("whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition", tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className={tab === "issues" ? "" : "hidden print:block"}><IssuesTab scanId={scan.id} findings={data.findings} ranking={ranking} /></div>
      <div className={tab === "pages" ? "" : "hidden"}><PagesTab data={data} /></div>
      <div className={tab === "links" ? "" : "hidden"}><LinksTab links={data.links} /></div>
      <div className={tab === "rendering" ? "" : "hidden print:block"}><RenderingTab data={data} /></div>
      <div className={tab === "performance" ? "" : "hidden print:block"}><PerformanceTab data={data} /></div>
      <div className={tab === "crawl" ? "" : "hidden"}><CrawlTab data={data} /></div>
    </div>
  );
}

function IssuesTab({ scanId, findings, ranking }: { scanId: string; findings: ClientFinding[]; ranking: Map<string, number> | null }) {
  const [q, setQ] = useState("");
  const [sev, setSev] = useState<Severity | "">("");
  const [cat, setCat] = useState("");
  const [type, setType] = useState("");
  // Advanced filters (Business): server-computed opportunity ranking, minimum affected pages, URL path and status.
  const [sort, setSort] = useState<"severity" | "opportunity">("severity");
  const [minPages, setMinPages] = useState(1);
  const [path, setPath] = useState("");
  const [hideIgnored, setHideIgnored] = useState(false);
  const advanced = !!ranking;
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    const pth = path.trim().toLowerCase();
    const base = findings.filter((f) => (!sev || f.severity === sev) && (!cat || f.category === cat) && (!type || f.type === type) && (!n || `${f.title} ${f.description} ${f.affectedUrls.join(" ")}`.toLowerCase().includes(n)));
    if (!advanced) return base;
    const pathOf = (u: string) => { try { const x = new URL(u); return (x.pathname + x.search).toLowerCase(); } catch { return u.toLowerCase(); } };
    const out = base.filter((f) => f.affectedCount >= minPages && (!pth || [f.affectedUrl, ...f.affectedUrls].some((u) => u && pathOf(u).includes(pth))) && (!hideIgnored || f.resolution?.status !== "ignored"));
    return sort === "opportunity" ? [...out].sort((a, b) => (ranking!.get(b.id) ?? 0) - (ranking!.get(a.id) ?? 0)) : out;
  }, [findings, q, sev, cat, type, advanced, minPages, path, hideIgnored, sort, ranking]);
  const clearAll = () => { setQ(""); setSev(""); setCat(""); setType(""); setMinPages(1); setPath(""); setHideIgnored(false); };
  const counts = useMemo(() => Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length])), [findings]);

  return (
    <div className="space-y-4">
      <FeedbackInvite />
      <div className="flex flex-wrap gap-2 print:hidden">
        {SEVERITIES.map((s) => (
          <button key={s} onClick={() => setSev(sev === s ? "" : s)} className={cn("rounded-md border px-3 py-1 text-xs font-medium transition", sev === s ? SEVERITY_STYLES[s].badge : "bg-card text-muted-foreground hover:bg-muted")} aria-pressed={sev === s}>
            {SEVERITY_LABELS[s]} · {counts[s]}
          </button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto] print:hidden">
        <Input placeholder="Search issues or URLs…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search issues" />
        <Select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Filter by category">
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
        </Select>
        <Select value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type">
          <option value="">All types</option>
          <option value="error">Errors</option>
          <option value="recommendation">Recommendations</option>
          <option value="observation">Observations</option>
        </Select>
      </div>
      {advanced ? (
        <div className="grid gap-2 rounded-md border bg-tint p-3 sm:grid-cols-[auto_auto_1fr_auto] sm:items-center print:hidden" role="group" aria-label="Advanced filters">
          <Select value={sort} onChange={(e) => setSort(e.target.value as "severity" | "opportunity")} aria-label="Order issues by">
            <option value="severity">Group by severity</option>
            <option value="opportunity">Rank by opportunity</option>
          </Select>
          <Select value={minPages} onChange={(e) => setMinPages(Number(e.target.value))} aria-label="Minimum affected pages">
            {[1, 2, 5, 10, 25].map((n) => <option key={n} value={n}>{n === 1 ? "Any number of pages" : `${n}+ pages affected`}</option>)}
          </Select>
          <Input placeholder="URL path contains, e.g. /blog" value={path} onChange={(e) => setPath(e.target.value)} aria-label="Affected URL path contains" />
          <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={hideIgnored} onChange={(e) => setHideIgnored(e.target.checked)} /> Hide ignored</label>
        </div>
      ) : null}
      {findings.length === 0 ? (
        <Card><EmptyState title="No issues found">None of the checks produced a finding for the pages scanned. That&apos;s a great result — remember the scan only covers the pages within the configured limits.</EmptyState></Card>
      ) : filtered.length === 0 ? (
        <Card><EmptyState title="No issues match your filters" action={<Button variant="outline" size="sm" onClick={clearAll}>Clear filters</Button>} /></Card>
      ) : advanced && sort === "opportunity" ? (
        <Card className="divide-y overflow-hidden">
          {filtered.map((f, i) => (
            <Link key={f.id} href={`/scans/${scanId}/issues/${f.id}`} className="print-break grid grid-cols-[2.5rem_1fr_auto] items-start gap-3 p-4 transition hover:bg-muted/40">
              <span className="font-mono text-xs text-primary">{String(i + 1).padStart(2, "0")}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={f.severity} /><span className="font-medium">{f.title}</span></div>
                <p className="mt-1 truncate text-sm text-muted-foreground">{f.evidence.summary}</p>
                <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{displayUrl(f.affectedUrl, 90)}{f.affectedCount > 1 ? ` + ${f.affectedCount - 1} more` : ""}</p>
              </div>
              <span className="text-right font-mono text-xs tabular-nums text-secondary" title="Opportunity score">{(ranking!.get(f.id) ?? 0).toFixed(1)}</span>
            </Link>
          ))}
        </Card>
      ) : (
        SEVERITIES.map((s) => {
          const list = filtered.filter((f) => f.severity === s);
          if (!list.length) return null;
          return (
            <section key={s} aria-label={`${SEVERITY_LABELS[s]} issues`}>
              <h3 className={cn("mb-2 mt-4 text-sm font-semibold", SEVERITY_STYLES[s].text)}>{SEVERITY_LABELS[s]} ({list.length})</h3>
              <Card className="divide-y overflow-hidden">
                {list.map((f) => (
                  <Link key={f.id} href={`/scans/${scanId}/issues/${f.id}`} className="print-break flex flex-col gap-1.5 p-4 transition hover:bg-muted/40 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <SeverityBadge severity={f.severity} />
                        <span className="font-medium">{f.title}</span>
                      </div>
                      <p className="mt-1 truncate text-sm text-muted-foreground" title={f.affectedUrl}>{f.evidence.summary}</p>
                      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{displayUrl(f.affectedUrl, 90)}{f.affectedCount > 1 ? ` + ${f.affectedCount - 1} more` : ""}</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      <TypeBadge type={f.type} />
                      <Badge className="border-border text-muted-foreground">{CATEGORY_LABELS[f.category]}</Badge>
                      {f.aiExplanationCached ? <Badge className="border-primary/30 bg-primary/10 text-primary">AI explained</Badge> : null}
                    </div>
                  </Link>
                ))}
              </Card>
            </section>
          );
        })
      )}
    </div>
  );
}

function PagesTab({ data }: { data: ResultsResponse }) {
  const [q, setQ] = useState("");
  const issueCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of data.findings) for (const u of f.affectedUrls) m.set(u, (m.get(u) ?? 0) + 1);
    return m;
  }, [data.findings]);
  const pages = data.pages.filter((p) => !q || `${p.url} ${p.title ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Card>
      <div className="border-b p-3"><Input placeholder="Filter pages…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter pages" /></div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr><th className="px-4 py-2.5 font-medium">Page</th><th className="px-3 py-2.5 font-medium">Status</th><th className="hidden px-3 py-2.5 font-medium md:table-cell">Time</th><th className="hidden px-3 py-2.5 font-medium lg:table-cell">Title</th><th className="hidden px-3 py-2.5 font-medium sm:table-cell">Links (int/ext)</th><th className="px-4 py-2.5 font-medium">Issues</th></tr>
          </thead>
          <tbody className="divide-y">
            {pages.map((p) => {
              const st = p.fetchError ? p.fetchError.code.replace(/_/g, " ") : p.statusCode ?? "—";
              const bad = !!p.fetchError || (p.statusCode ?? 0) >= 400;
              return (
                <tr key={p.id} className="align-top">
                  <td className="max-w-[22rem] px-4 py-2.5">
                    <a href={p.finalUrl} target="_blank" rel="noopener noreferrer nofollow" className="block truncate font-mono text-xs hover:underline" title={p.url}>{displayUrl(p.url, 70)}</a>
                    {p.redirectChain.length ? <span className="block truncate text-xs text-muted-foreground">→ {displayUrl(p.finalUrl, 60)}</span> : null}
                    <span className="text-xs text-muted-foreground">depth {p.depth} · via {p.discoveredVia}{p.isHtml ? "" : ` · ${p.contentType ?? "unknown type"}`}</span>
                  </td>
                  <td className={cn("px-3 py-2.5 tabular-nums", bad && "font-medium text-danger")}>{st}{p.redirectChain.length ? <span className="block text-xs text-muted-foreground">{p.redirectChain.length} redirect(s)</span> : null}</td>
                  <td className="hidden px-3 py-2.5 tabular-nums text-muted-foreground md:table-cell">{formatDuration(p.responseTimeMs)}</td>
                  <td className="hidden max-w-[16rem] truncate px-3 py-2.5 lg:table-cell" title={p.title ?? ""}>{p.title ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="hidden px-3 py-2.5 tabular-nums text-muted-foreground sm:table-cell">{p.internalLinkCount}/{p.externalLinkCount}</td>
                  <td className="px-4 py-2.5 tabular-nums">{issueCount.get(p.finalUrl) ?? issueCount.get(p.url) ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const LINK_FILTERS = [
  ["broken", "Broken"],
  ["inconclusive", "Unverified"],
  ["redirect", "Redirects"],
  ["ok", "OK"],
  ["not_checked", "Not checked"],
  ["all", "All"],
] as const;

function linkMatches(l: LinkCheckRecord, f: (typeof LINK_FILTERS)[number][0]) {
  if (f === "all") return true;
  if (f === "broken") return BROKEN_CATEGORIES.includes(l.category);
  if (f === "inconclusive") return INCONCLUSIVE_CATEGORIES.includes(l.category);
  if (f === "not_checked") return l.verification === "not_checked";
  return l.category === f;
}

function LinksTab({ links }: { links: LinkCheckRecord[] }) {
  const [filter, setFilter] = useState<(typeof LINK_FILTERS)[number][0]>(() => (links.some((l) => BROKEN_CATEGORIES.includes(l.category)) ? "broken" : "all"));
  const [scope, setScope] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const list = links.filter((l) => linkMatches(l, filter) && (scope === "all" || (scope === "internal") === l.internal));
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        {LINK_FILTERS.map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k} className={cn("rounded-md border px-3 py-1 text-xs font-medium", filter === k ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")}>
            {label} · {links.filter((l) => linkMatches(l, k)).length}
          </button>
        ))}
        <Select value={scope} onChange={(e) => setScope(e.target.value)} className="ml-auto h-8 text-xs" aria-label="Link scope">
          <option value="all">Internal & external</option>
          <option value="internal">Internal only</option>
          <option value="external">External only</option>
        </Select>
      </div>
      {list.length === 0 ? (
        <EmptyState title="No links in this view" />
      ) : (
        <ul className="divide-y">
          {list.slice(0, 500).map((l) => (
            <li key={l.id} className="p-3 text-sm">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="block truncate font-mono text-xs hover:underline" title={l.url}>{displayUrl(l.url, 90)}</a>
                  <p className="text-xs text-muted-foreground">{l.message}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Badge className={cn(BROKEN_CATEGORIES.includes(l.category) ? "border-danger/30 bg-danger-soft text-danger" : INCONCLUSIVE_CATEGORIES.includes(l.category) ? "border-warning/30 bg-warning-soft text-warning" : "border-border text-muted-foreground")}>
                    {l.statusCode ?? l.category.replace(/_/g, " ")}
                  </Badge>
                  <Badge className="border-border text-muted-foreground">{l.internal ? "Internal" : "External"}</Badge>
                  {l.kind === "image" ? <Badge className="border-border text-muted-foreground">Image</Badge> : null}
                  <Badge className="border-border text-muted-foreground">{l.verification.replace("_", " ")}</Badge>
                  {l.sources.length ? (
                    <button className="text-xs font-medium text-primary hover:underline" onClick={() => setOpen(open === l.id ? null : l.id)} aria-expanded={open === l.id}>
                      {l.sources.length} source page{l.sources.length === 1 ? "" : "s"}
                    </button>
                  ) : <span className="text-xs text-muted-foreground">from sitemap</span>}
                </div>
              </div>
              {open === l.id ? (
                <ul className="mt-2 space-y-0.5 rounded-lg bg-muted/50 p-2">
                  {l.sources.map((s) => <li key={s} className="truncate font-mono text-xs text-muted-foreground">{s}</li>)}
                  <li className="text-xs text-muted-foreground">Checked {formatDateTime(l.checkedAt)} via {l.method}</li>
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {list.length > 500 ? <p className="border-t p-3 text-xs text-muted-foreground">Showing the first 500. Download the JSON export for the complete list.</p> : null}
    </Card>
  );
}

function CrawlTab({ data }: { data: ResultsResponse }) {
  const c = data.scan.crawl;
  const l = data.scan.limits;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-5 text-sm">
        <h3 className="font-semibold">robots.txt</h3>
        {c.robots ? (
          <dl className="mt-2 space-y-1 text-muted-foreground">
            <div className="flex justify-between gap-4"><dt>URL</dt><dd className="truncate font-mono text-xs">{c.robots.url}</dd></div>
            <div className="flex justify-between gap-4"><dt>Result</dt><dd>{c.robots.status.replace("_", " ")}{c.robots.httpStatus ? ` (HTTP ${c.robots.httpStatus})` : ""}</dd></div>
            <div className="flex justify-between gap-4"><dt>Crawl-delay applied</dt><dd>{c.robots.crawlDelayMs ? `${c.robots.crawlDelayMs} ms` : "none"}</dd></div>
            <div className="flex justify-between gap-4"><dt>Sitemaps declared</dt><dd>{c.robots.sitemaps.length}</dd></div>
          </dl>
        ) : <p className="mt-2 text-muted-foreground">Not checked.</p>}
        <h3 className="mt-5 font-semibold">Sitemaps</h3>
        {c.sitemap && c.sitemap.checked.length ? (
          <ul className="mt-2 space-y-1">
            {c.sitemap.checked.map((s) => (
              <li key={s.url} className="flex justify-between gap-4 text-muted-foreground"><span className="truncate font-mono text-xs">{s.url}</span><span className="shrink-0 text-xs">{s.type === "urlset" || s.type === "index" ? `${s.type}, ${s.urlCount} URLs` : s.error ?? s.type}</span></li>
            ))}
          </ul>
        ) : <p className="mt-2 text-muted-foreground">{c.sitemap?.status === "not_checked" ? "Not checked." : "No sitemap found."}</p>}
      </Card>
      <Card className="p-5 text-sm">
        <h3 className="font-semibold">Crawl scope & limits</h3>
        <dl className="mt-2 space-y-1 text-muted-foreground">
          <div className="flex justify-between gap-4"><dt>Hosts crawled</dt><dd className="text-right font-mono text-xs">{c.allowedHosts.join(", ")} (and www variant)</dd></div>
          <div className="flex justify-between gap-4"><dt>Page limit / depth</dt><dd>{l.maxPages} pages / depth {l.maxDepth}</dd></div>
          <div className="flex justify-between gap-4"><dt>Link-check limit</dt><dd>{l.maxLinksToCheck} destinations</dd></div>
          <div className="flex justify-between gap-4"><dt>Time limit</dt><dd>{formatDuration(l.maxDurationMs)}</dd></div>
          <div className="flex justify-between gap-4"><dt>All discovered pages crawled</dt><dd>{c.crawlTruncated ? "No — some URLs were skipped (see below)" : "Yes"}</dd></div>
        </dl>
        <h3 className="mt-5 font-semibold">URLs not crawled</h3>
        <dl className="mt-2 space-y-1 text-muted-foreground">
          <div className="flex justify-between"><dt>Disallowed by robots.txt</dt><dd className="tabular-nums">{c.skipped.robots}</dd></div>
          <div className="flex justify-between"><dt>Beyond page limit</dt><dd className="tabular-nums">{c.skipped.limit}</dd></div>
          <div className="flex justify-between"><dt>Beyond depth limit</dt><dd className="tabular-nums">{c.skipped.depth}</dd></div>
          <div className="flex justify-between"><dt>Filtered (login areas, faceted/parameter URLs)</dt><dd className="tabular-nums">{c.skipped.traps}</dd></div>
        </dl>
      </Card>
    </div>
  );
}
