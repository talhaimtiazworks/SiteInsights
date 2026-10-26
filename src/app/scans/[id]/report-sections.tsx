"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { SeverityBadge } from "@/components/badges";
import { Alert, Badge, Button, Card, CardHeader, cn, EmptyState, Spinner } from "@/components/ui";
import { CATEGORY_LABELS } from "@/lib/audit/types";
import { ACCESSIBILITY_DISCLAIMER, coverageRows, priorityFindings, sentence } from "@/lib/report/summary";
import { displayUrl, formatDateTime, formatDuration } from "@/lib/client/format";
import type { ClientFinding, PerformanceRun, RenderSummary, ResultsResponse } from "@/lib/client/types";

export { ACCESSIBILITY_DISCLAIMER };

const STATE_STYLE = {
  done: "border-success/30 bg-success-soft text-success",
  partial: "border-warning/30 bg-warning-soft text-warning",
  skipped: "border-border bg-muted text-muted-foreground",
};
const STATE_LABEL = { done: "Evaluated", partial: "Partial", skipped: "Not evaluated" };

export function CoverageCard({ data }: { data: ResultsResponse }) {
  const rows = coverageRows(data);
  return (
    <Card>
      <CardHeader title="What this audit covered" description="Categories that were not evaluated have no score and do not affect other scores." />
      <ul className="divide-y">
        {rows.map((r) => (
          <li key={r.label} className="flex flex-col gap-1 px-5 py-3 text-sm sm:flex-row sm:items-start sm:gap-4">
            <span className="w-48 shrink-0 font-medium">{r.label}</span>
            <Badge className={cn("w-fit shrink-0", STATE_STYLE[r.state])}>{STATE_LABEL[r.state]}</Badge>
            <span className="min-w-0 text-muted-foreground">{r.detail}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ------------------------------------------------------------------ action plan
export function ActionPlan({ scanId, findings }: { scanId: string; findings: ClientFinding[] }) {
  const top = priorityFindings(findings);
  return (
    <Card className="print-break">
      <CardHeader title="Action plan" description="The most important fixes first, ordered by severity and how many pages are affected." />
      {top.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">No critical, high or medium issues were found. Review the remaining recommendations in the issue list below.</p>
      ) : (
        <ol className="divide-y">
          {top.map((f, i) => (
            <li key={f.id} className="flex gap-3 px-5 py-3 text-sm">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary tabular-nums">{i + 1}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/scans/${scanId}/issues/${f.id}`} className="font-medium hover:underline">{f.title}</Link>
                  <SeverityBadge severity={f.severity} />
                  <span className="text-xs text-muted-foreground">{CATEGORY_LABELS[f.category]} · {f.affectedCount} affected</span>
                </div>
                <p className="mt-0.5 text-muted-foreground">{f.recommendation}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ performance
const fmtMs = (v: number | null) => (v === null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const fmtCls = (v: number | null) => (v === null ? "—" : v.toFixed(2));
const fmtBytes = (v: number | null) => (v === null ? "—" : v >= 1_048_576 ? `${(v / 1_048_576).toFixed(1)} MB` : `${Math.round(v / 1024)} KB`);

function rate(v: number | null, good: number, poor: number) {
  if (v === null) return "text-muted-foreground";
  return v <= good ? "text-success" : v <= poor ? "text-warning" : "text-danger";
}
const FIELD_LABEL = { good: "Good", needs_improvement: "Needs improvement", poor: "Poor" } as const;
const FIELD_STYLE = { good: "text-success", needs_improvement: "text-warning", poor: "text-danger" } as const;

function Metric({ label, value, className, hint }: { label: string; value: string; className?: string; hint?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 text-lg font-semibold tabular-nums", className)}>{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function PerformanceRunCard({ run }: { run: PerformanceRun }) {
  const device = run.strategy === "mobile" ? "Mobile (emulated)" : "Desktop";
  if (!run.ok) {
    return (
      <Card className="p-5">
        <h3 className="font-semibold">{device}</h3>
        <p className="mt-2 text-sm text-muted-foreground">Not evaluated: {run.error?.message ?? "the test did not complete."}</p>
      </Card>
    );
  }
  const f = run.field;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{device}</h3>
        <span className="text-xs text-muted-foreground">Tested {formatDateTime(run.fetchedAt)}{run.lighthouseVersion ? ` · Lighthouse ${run.lighthouseVersion}` : ""} via PageSpeed Insights</span>
      </div>
      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{run.finalUrl ?? run.url}</p>

      <h4 className="mt-4 text-sm font-medium">Lab data <span className="font-normal text-muted-foreground">— one simulated page load</span></h4>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric label="Performance score" value={run.score === null ? "—" : String(run.score)} className={run.score === null ? "" : run.score >= 90 ? FIELD_STYLE.good : run.score >= 50 ? FIELD_STYLE.needs_improvement : FIELD_STYLE.poor} />
        <Metric label="Largest Contentful Paint" value={fmtMs(run.lab.lcpMs)} className={rate(run.lab.lcpMs, 2500, 4000)} />
        <Metric label="Total Blocking Time" value={fmtMs(run.lab.tbtMs)} className={rate(run.lab.tbtMs, 200, 600)} hint="Lab proxy for responsiveness — not INP" />
        <Metric label="Cumulative Layout Shift" value={fmtCls(run.lab.cls)} className={rate(run.lab.cls, 0.1, 0.25)} />
        <Metric label="First Contentful Paint" value={fmtMs(run.lab.fcpMs)} className={rate(run.lab.fcpMs, 1800, 3000)} />
        <Metric label="Speed Index" value={fmtMs(run.lab.speedIndexMs)} className={rate(run.lab.speedIndexMs, 3400, 5800)} />
      </div>

      <h4 className="mt-4 text-sm font-medium">Field data <span className="font-normal text-muted-foreground">— real Chrome users, 75th percentile over the last 28 days</span></h4>
      {f ? (
        <>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {([["Largest Contentful Paint", f.lcp, fmtMs], ["Interaction to Next Paint", f.inp, fmtMs], ["Cumulative Layout Shift", f.cls, fmtCls]] as const).map(([label, m, fmt]) => (
              <Metric key={label} label={label} value={m ? fmt(m.p75) : "No data"} className={m?.category ? FIELD_STYLE[m.category] : "text-muted-foreground"} hint={m?.category ? FIELD_LABEL[m.category] : undefined} />
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Source: Chrome UX Report ({f.scope === "origin" ? "whole-site data — not enough traffic for this exact URL" : "this URL"}).</p>
        </>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">No field data: the Chrome UX Report has too little real-user traffic for this page or site. INP can only be measured from real users, so it is not evaluated.</p>
      )}

      <h4 className="mt-4 text-sm font-medium">Resources</h4>
      <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-muted-foreground sm:grid-cols-3">
        <div><dt className="inline">Page weight: </dt><dd className="inline tabular-nums">{fmtBytes(run.resources.totalBytes)}</dd></div>
        <div><dt className="inline">Requests: </dt><dd className="inline tabular-nums">{run.resources.requestCount ?? "—"}</dd></div>
        <div><dt className="inline">Render-blocking: </dt><dd className="inline tabular-nums">{run.resources.renderBlocking.length}</dd></div>
        <div><dt className="inline">Unused JavaScript: </dt><dd className="inline tabular-nums">{fmtBytes(run.resources.unusedJsBytes)}</dd></div>
        <div><dt className="inline">Image savings: </dt><dd className="inline tabular-nums">{fmtBytes(run.resources.imageSavingsBytes)}</dd></div>
        <div><dt className="inline">Short cache lifetimes: </dt><dd className="inline tabular-nums">{run.resources.cacheIssues ?? "—"}</dd></div>
      </dl>
      {run.opportunities.length ? (
        <>
          <h4 className="mt-4 text-sm font-medium">Top opportunities</h4>
          <ul className="mt-1 space-y-1 text-sm">
            {run.opportunities.slice(0, 6).map((o) => (
              <li key={o.id} className="flex justify-between gap-3"><span>{o.title}</span><span className="shrink-0 tabular-nums text-muted-foreground">{o.displayValue ?? (o.savingsMs ? `≈${fmtMs(o.savingsMs)}` : o.savingsBytes ? `≈${fmtBytes(o.savingsBytes)}` : "")}</span></li>
            ))}
          </ul>
        </>
      ) : null}
      {run.warnings.length ? <p className="mt-3 text-xs text-muted-foreground">Lighthouse notes: {run.warnings.slice(0, 3).join(" ")}</p> : null}
    </Card>
  );
}

export function PerformanceTab({ data }: { data: ResultsResponse }) {
  const runs = data.performance ?? [];
  const reason = data.scan.summary?.coverage?.performance.skippedReason;
  if (!runs.length) {
    return <EmptyState title="Performance not evaluated">{sentence(reason) || "This audit did not include a performance test."} No performance values are shown or scored.</EmptyState>;
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Performance is tested on the start page only. Lab results vary between runs; field data reflects real visitors and changes slowly.</p>
      <div className="grid gap-4 xl:grid-cols-2">{runs.map((r) => <PerformanceRunCard key={r.strategy} run={r} />)}</div>
    </div>
  );
}

// ------------------------------------------------------------------ rendering
export function RenderingTab({ data }: { data: ResultsResponse }) {
  const renders: RenderSummary[] = data.renders ?? [];
  const cov = data.scan.summary?.coverage;
  return (
    <div className="space-y-4">
      <Alert tone="info" title="About accessibility results">{ACCESSIBILITY_DISCLAIMER}</Alert>
      {!renders.length ? (
        <EmptyState title="Browser rendering not evaluated">{sentence(cov?.browser.skippedReason) || "Pages were audited from their HTML only."} JavaScript-dependent issues and axe-core tests were not checked.</EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Page</th>
                  <th className="px-3 py-2.5 font-medium">Result</th>
                  <th className="hidden px-3 py-2.5 font-medium sm:table-cell">JS errors</th>
                  <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Failed requests</th>
                  <th className="hidden px-3 py-2.5 font-medium md:table-cell">Mobile layout</th>
                  <th className="px-4 py-2.5 font-medium">Accessibility</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {renders.map((r) => (
                  <tr key={r.url} className="align-top">
                    <td className="max-w-[18rem] px-4 py-2.5">
                      <span className="block truncate font-mono text-xs" title={r.url}>{displayUrl(r.url, 60)}</span>
                      <span className="text-xs text-muted-foreground">{r.viewport.width}×{r.viewport.height} · {r.requestCount} requests{r.blockedRequestCount ? ` · ${r.blockedRequestCount} blocked for safety` : ""}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      {r.ok ? <span className="text-success">Rendered</span> : <span className="text-warning" title={r.error?.message}>{r.error?.code.replace(/_/g, " ") ?? "failed"}</span>}
                      <span className="block text-xs text-muted-foreground">{formatDuration(r.totalMs)}{r.ok && r.readiness ? ` · ${r.readiness.replace(/_/g, " ")}` : ""}</span>
                    </td>
                    <td className={cn("hidden px-3 py-2.5 tabular-nums sm:table-cell", r.consoleErrors > 0 && "text-danger")}>{r.ok ? r.consoleErrors : "—"}</td>
                    <td className={cn("hidden px-3 py-2.5 tabular-nums sm:table-cell", r.failedRequests > 0 && "text-danger")}>{r.ok ? r.failedRequests : "—"}</td>
                    <td className="hidden px-3 py-2.5 text-xs md:table-cell">
                      {r.mobile ? [r.mobile.horizontalOverflow ? "Horizontal scrolling" : null, r.mobile.smallText ? `${r.mobile.smallText} small text` : null, r.mobile.smallTapTargets ? `${r.mobile.smallTapTargets} small tap targets` : null].filter(Boolean).join(", ") || <span className="text-muted-foreground">No issues found</span> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      {r.axe ? (r.axe.violations ? <span>{r.axe.violations} rule(s) failed on {r.axe.affectedNodes} element(s)</span> : <span className="text-success">No automated violations</span>) : <span className="text-muted-foreground">{r.axeError ? "axe-core did not run" : "Not tested"}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <p className="text-xs text-muted-foreground">
        Individual problems, with selectors and fixes, are listed under Issues (categories &ldquo;{CATEGORY_LABELS.browser}&rdquo; and &ldquo;{CATEGORY_LABELS.accessibility}&rdquo;).
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ PDF
export function PdfButton({ scanId, filename }: { scanId: string; filename: string }) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function download() {
    if (busy || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/scans/${scanId}/report.pdf`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(90_000) });
      if (res.status === 401) window.dispatchEvent(new Event("siteinsights:session-expired"));
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.includes("application/pdf")) {
        let message = "The PDF could not be created. Please try again.";
        try {
          const body = await res.json();
          if (body?.error?.message) message = body.error.message;
        } catch {
          /* not JSON */
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      if (blob.size < 100) throw new Error("The PDF could not be created. Please try again.");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) {
      setError(e instanceof TypeError ? "Could not reach the server. Check your connection and try again." : (e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="relative inline-flex flex-col items-end">
      <Button variant="outline" size="sm" onClick={download} disabled={busy} aria-busy={busy} aria-describedby={error ? "pdf-error" : undefined}>
        {busy ? <Spinner /> : null}
        {busy ? "Preparing PDF…" : "Download PDF"}
      </Button>
      {error ? <span id="pdf-error" role="alert" className="mt-1 max-w-64 text-right text-xs text-danger">{error}</span> : null}
    </div>
  );
}

// ------------------------------------------------------------------ private link
/** Report URLs never grant access: the owner or a verified team member must sign in. */
export function PrivateLinkButton({ scanId }: { scanId: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [link] = useState(() => (typeof window === "undefined" ? null : `${window.location.origin}/scans/${encodeURIComponent(scanId)}`));
  if (!link) return null;
  async function copy() {
    try {
      await navigator.clipboard.writeText(link!);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 4000);
  }
  return (
    <div className="relative inline-flex flex-col items-end">
      <Button variant="outline" size="sm" onClick={copy} title="Only you and authorized team members can open this report after signing in.">
        {state === "copied" ? "Link copied" : "Copy report URL"}
      </Button>
      <span role="status" className="sr-only">{state === "copied" ? "Report URL copied. Sign-in and account authorization are still required." : ""}</span>
      {state === "failed" ? <span role="alert" className="mt-1 max-w-64 text-right text-xs text-danger">Couldn&apos;t copy. Your browser blocked clipboard access.</span> : null}
    </div>
  );
}
