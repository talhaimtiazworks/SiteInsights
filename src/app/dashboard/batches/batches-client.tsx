"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StatusBadge } from "@/components/badges";
import { DashboardNav } from "@/components/dashboard-nav";
import { InlineError } from "@/components/load-error";
import { TableSkeleton } from "@/components/skeletons";
import { Alert, Button, Card, CardHeader, EmptyState, PageHeader, Select, Spinner, cn } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { displayUrl, formatDateTime } from "@/lib/client/format";
import type { BatchInfo, BatchItemInfo } from "@/lib/client/types";
import { useCredits } from "@/lib/client/use-credits";

interface PlanInfo { id: string; name: string; maxPagesPerAudit: number; maxBatchSize: number; features: { batchAudits: boolean } }
const ACTIVE = new Set(["queued", "running"]);

function parseUrls(text: string): string[] {
  return Array.from(new Set(text.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean)));
}

function batchCounts(b: BatchInfo) {
  let done = 0, running = 0, waiting = 0, failed = 0;
  for (const i of b.items) {
    if (i.status === "pending") waiting++;
    else if (i.status === "failed" || i.status === "skipped") failed++;
    else if (i.audit && ACTIVE.has(i.audit.status)) running++;
    else if (i.audit?.status === "failed") failed++;
    else done++;
  }
  return { done, running, waiting, failed };
}

export function BatchesClient() {
  const credits = useCredits(true);
  const [plans, setPlans] = useState<PlanInfo[] | null>(null);
  const [batches, setBatches] = useState<BatchInfo[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [text, setText] = useState("");
  const [pages, setPages] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiClientError | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const loadList = useCallback(() => {
    api<{ batches: BatchInfo[] }>("/api/batches")
      .then((d) => { setBatches(d.batches); setError(null); })
      .catch(setError);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      loadList();
      api<{ plans: PlanInfo[] }>("/api/plans").then((d) => setPlans(d.plans)).catch(setError);
    }, 0);
    return () => clearTimeout(t);
  }, [loadList]);

  const s = credits.summary;
  const plan = plans && s ? plans.find((p) => p.id === s.plan.id) ?? null : null;
  const allowed = !!plan?.features.batchAudits && plan.maxBatchSize > 0;
  const maxPages = s?.plan.maxPagesPerAudit ?? 0;
  const perAudit = pages ?? maxPages;
  const urls = useMemo(() => parseUrls(text), [text]);
  const tooMany = !!plan && urls.length > plan.maxBatchSize;
  const pageOptions = [10, 25, 50, 100, 150, 250, 500].filter((n) => n < maxPages).concat(maxPages > 0 ? [maxPages] : []);

  return (
    <div className="container space-y-6 py-8 sm:py-10">
      <PageHeader title="Batch audits" description="Queue several websites at once — free, like everything in SiteInsights. They run one after another within the deployment's concurrency, each with the normal audit checks and technical safeguards." />
      <DashboardNav />

      {credits.error ? <Card><InlineError error={credits.error} what="your usage" onRetry={credits.reload} /></Card> : null}
      {s && plans && !allowed ? (
        <Alert tone="info" title="Batch audits are not enabled on this deployment">
          You can still audit sites one at a time for free from <Link href="/audit/new" className="font-medium text-primary hover:underline">New audit</Link>.
        </Alert>
      ) : null}

      {s && plan && allowed ? (
        <Card>
          <CardHeader title="New batch" description={`Up to ${plan.maxBatchSize} websites, one per line. Duplicate sites are audited once.`} />
          <form
            className="space-y-4 px-5 pb-5"
            onSubmit={async (e) => {
              e.preventDefault();
              setSubmitting(true);
              setSubmitError(null);
              try {
                const r = await api<{ batch: BatchInfo }>("/api/batches", { method: "POST", json: { urls, maxPages: perAudit } });
                setText("");
                setOpenId(r.batch.id);
                loadList();
                credits.reload();
              } catch (err) {
                setSubmitError(err as ApiClientError);
              } finally {
                setSubmitting(false);
              }
            }}
          >
            <label className="block text-sm">
              <span className="font-medium">Websites</span>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} maxLength={60_000} placeholder={"https://example.com\nhttps://another-example.org"} className="mt-1 w-full rounded-md border bg-card px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </label>
            <div className="flex flex-wrap items-end gap-4">
              <label className="text-sm">
                <span className="font-medium">Pages per site</span>
                <Select value={perAudit} onChange={(e) => setPages(Number(e.target.value))} className="mt-1 h-10 w-40">
                  {pageOptions.map((n) => <option key={n} value={n}>{n === maxPages ? `${n} (plan maximum)` : n}</option>)}
                </Select>
              </label>
              <div className="text-sm" aria-live="polite">
                <p><span className="font-medium tabular-nums">{urls.length}</span> site{urls.length === 1 ? "" : "s"} · free of charge</p>
                <p className="text-xs text-muted-foreground">No credits and no balance to watch — batch audits are included for everyone.</p>
              </div>
            </div>
            {tooMany ? <p role="alert" className="text-sm text-danger">Remove {urls.length - plan.maxBatchSize} site{urls.length - plan.maxBatchSize === 1 ? "" : "s"}: a batch holds up to {plan.maxBatchSize}.</p> : null}

            {submitError ? (
              <Alert tone="error">
                {submitError.message}
                {Array.isArray((submitError.details as { rejected?: unknown })?.rejected) ? (
                  <ul className="mt-2 list-disc pl-5 text-xs">
                    {((submitError.details as { rejected: Array<{ url: string; reason: string }> }).rejected).slice(0, 10).map((r) => <li key={r.url}><span className="font-mono">{r.url}</span>: {r.reason}</li>)}
                  </ul>
                ) : null}
              </Alert>
            ) : null}
            <Button type="submit" disabled={submitting || urls.length === 0 || tooMany}>{submitting ? <Spinner /> : null}Queue {urls.length || ""} audit{urls.length === 1 ? "" : "s"}</Button>
          </form>
        </Card>
      ) : null}

      {error ? <Card><InlineError error={error} what="your batches" onRetry={loadList} /></Card> : null}
      {!batches && !error ? <TableSkeleton rows={3} /> : null}
      {batches && batches.length === 0 ? <EmptyState title="No batches yet">{allowed ? "Paste a list of websites above to audit them in one go." : "Batches you queue appear here."}</EmptyState> : null}
      {batches && batches.length > 0 ? (
        <ul className="space-y-3" aria-label="Batches">
          {batches.map((b) => <BatchRow key={b.id} summary={b} open={openId === b.id} onToggle={() => setOpenId(openId === b.id ? null : b.id)} />)}
        </ul>
      ) : null}
    </div>
  );
}

function BatchRow({ summary, open, onToggle }: { summary: BatchInfo; open: boolean; onToggle: () => void }) {
  const [detail, setDetail] = useState<BatchInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const b = detail ?? summary;
  const counts = detail ? batchCounts(detail) : null;
  const active = !!counts && (counts.running > 0 || counts.waiting > 0);

  const load = useCallback(() => {
    api<{ batch: BatchInfo }>(`/api/batches/${summary.id}`)
      .then((d) => { setDetail(d.batch); setError(null); })
      .catch(setError);
  }, [summary.id]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [open, load]);

  // Poll real server state while anything in the batch is still waiting or running.
  useEffect(() => {
    if (!open || !active) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, 5000);
    return () => clearInterval(id);
  }, [open, active, load]);

  return (
    <li>
      <Card>
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left">
          <span>
            <span className="font-medium">{b.items.length} website{b.items.length === 1 ? "" : "s"}</span>
            <span className="ml-2 text-sm text-muted-foreground">queued {formatDateTime(b.createdAt)}</span>
          </span>
          <span className="text-sm text-muted-foreground">
            {counts ? `${counts.done} done · ${counts.running} running · ${counts.waiting} waiting${counts.failed ? ` · ${counts.failed} failed` : ""}` : open ? "Loading" : "Show"}
          </span>
        </button>
        {open ? (
          <div className="border-t">
            {error ? <InlineError error={error} what="this batch" onRetry={load} /> : null}
            {!detail && !error ? <TableSkeleton rows={Math.min(5, b.items.length)} className="m-5" /> : null}
            {detail ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <tr><th className="px-5 py-2 font-medium">Website</th><th className="px-5 py-2 font-medium">Status</th><th className="px-5 py-2 text-right font-medium">Pages</th><th className="px-5 py-2 text-right font-medium">Score</th></tr>
                  </thead>
                  <tbody className="divide-y">{detail.items.map((i) => <ItemRow key={i.id} i={i} />)}</tbody>
                </table>
              </div>
            ) : null}
            {active ? <p className="border-t px-5 py-2 text-xs text-muted-foreground">Updating every few seconds from the server. You can leave this page; the batch keeps running.</p> : null}
          </div>
        ) : null}
      </Card>
    </li>
  );
}

function ItemRow({ i }: { i: BatchItemInfo }) {
  const a = i.audit;
  return (
    <tr className="align-top">
      <td className="max-w-[18rem] truncate px-5 py-3 font-medium" title={i.url}>{a ? <Link href={a.hasResults ? `/scans/${a.id}` : `/scans/${a.id}/progress`} className="text-primary hover:underline">{displayUrl(i.url)}</Link> : displayUrl(i.url)}</td>
      <td className="px-5 py-3">
        {a ? <StatusBadge status={a.status} /> : <span className={cn("text-sm", i.status === "failed" || i.status === "skipped" ? "text-danger" : "text-muted-foreground")}>{i.status === "pending" ? "Waiting for a free slot" : i.status === "skipped" ? "Skipped" : i.status === "failed" ? "Could not start" : "Started"}</span>}
        {i.error ? <p className="mt-0.5 text-xs text-muted-foreground">{i.error}</p> : null}
      </td>
      <td className="px-5 py-3 text-right tabular-nums">{a ? `${a.progress.pagesCrawled} / ${a.limits.maxPages}` : `up to ${i.maxPages}`}</td>
      <td className="px-5 py-3 text-right tabular-nums">{a?.overallScore ?? "–"}</td>
    </tr>
  );
}
