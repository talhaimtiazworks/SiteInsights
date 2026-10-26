"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { StatusBadge } from "@/components/badges";
import { AuditOwnerActions } from "@/components/audit-owner-actions";
import { isPermanentScanError, ScanAccessError } from "@/components/scan-access-error";
import { useSystemStatus } from "@/components/system-notice";
import { Alert, Button, ButtonLink, Card, LoadingRegion, ProgressBar, Skeleton, Spinner } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { displayUrl, formatDuration } from "@/lib/client/format";
import type { PublicScan } from "@/lib/client/types";

type PhaseId = "discovery" | "crawling" | "rendering" | "checking_links" | "performance" | "analyzing";
interface PhaseDef {
  id: PhaseId;
  label: string;
  weight: number;
}

const TERMINAL = ["completed", "completed_with_warnings", "failed", "cancelled"];
const ORDER: PhaseId[] = ["discovery", "crawling", "rendering", "checking_links", "performance", "analyzing"];

/** Phases that apply to this scan (optional ones only when enabled for it). */
function phasesFor(s: PublicScan): PhaseDef[] {
  const list: PhaseDef[] = [
    { id: "discovery", label: "Reading robots.txt and sitemaps", weight: 4 },
    { id: "crawling", label: "Crawling pages", weight: 50 },
  ];
  if ((s.limits.browserPages ?? 0) > 0) list.push({ id: "rendering", label: s.limits.accessibility ? "Rendering pages and testing accessibility" : "Rendering pages in a browser", weight: 16 });
  list.push({ id: "checking_links", label: "Checking links", weight: 26 });
  if ((s.limits.performanceStrategies ?? []).length > 0) list.push({ id: "performance", label: "Measuring performance", weight: 12 });
  list.push({ id: "analyzing", label: "Analysing results", weight: 3 });
  return list;
}

/** Fraction (0–1) of the current phase that is done, from real counters. */
function phaseFraction(s: PublicScan, id: PhaseId): number {
  const p = s.progress;
  switch (id) {
    case "crawling": {
      // Newer audits report exactly what is left in the queue; older ones fall back to discovered URLs.
      const processed = p.pagesCrawled + (p.pagesFailed ?? 0);
      const target = p.pagesRemaining !== undefined ? Math.max(1, Math.min(s.limits.maxPages, processed + p.pagesRemaining)) : Math.max(1, Math.min(s.limits.maxPages, p.pagesDiscovered));
      return Math.min(1, processed / target);
    }
    case "rendering":
      return p.renderTotal ? Math.min(1, (p.pagesRendered ?? 0) / p.renderTotal) : 0;
    case "checking_links":
      return p.linksTotal > 0 ? Math.min(1, p.linksChecked / p.linksTotal) : 0;
    case "performance":
      return p.performanceTotal ? Math.min(1, (p.performanceDone ?? 0) / p.performanceTotal) : 0;
    default:
      return 0;
  }
}

function percent(s: PublicScan, phases: PhaseDef[]): number {
  if (TERMINAL.includes(s.status)) return 100;
  const total = phases.reduce((a, b) => a + b.weight, 0);
  let done = 0;
  for (const ph of phases) {
    if (ORDER.indexOf(ph.id) < ORDER.indexOf(s.phase as PhaseId)) done += ph.weight;
    else if (ph.id === s.phase) done += ph.weight * phaseFraction(s, ph.id);
  }
  return Math.round((done / total) * 100);
}

function phaseDetail(s: PublicScan, id: PhaseId, reached: boolean): string {
  const p = s.progress;
  if (!reached) return "";
  switch (id) {
    case "discovery":
      return s.crawl?.sitemap ? `${s.crawl.sitemap.urlsFound} sitemap URLs found` : "";
    case "crawling":
      return `${p.pagesCrawled} of up to ${s.limits.maxPages} pages · ${p.pagesDiscovered} URLs discovered`;
    case "rendering":
      return p.renderTotal ? `${p.pagesRendered ?? 0} of ${p.renderTotal} pages rendered` : "";
    case "checking_links":
      return p.linksTotal > 0 ? `${p.linksChecked} of ${p.linksTotal} link destinations` : "";
    case "performance":
      return p.performanceTotal ? `${p.performanceDone ?? 0} of ${p.performanceTotal} tests (mobile / desktop)` : "";
    case "analyzing":
      return s.summary ? `${s.summary.totalFindings} findings` : "";
  }
}

/** Keeps whichever snapshot is newer, so a slow poll never overwrites fresher data. */
function newer(prev: PublicScan | null, next: PublicScan): PublicScan {
  if (!prev) return next;
  if (TERMINAL.includes(prev.status) && !TERMINAL.includes(next.status)) return prev;
  return next.updatedAt >= prev.updatedAt ? next : prev;
}

const MAX_TRANSIENT_FAILURES = 6;

export function ProgressClient({ id }: { id: string }) {
  const router = useRouter();
  const [scan, setScan] = useState<PublicScan | null>(null);
  const system = useSystemStatus();
  const [fatal, setFatal] = useState<ApiClientError | null>(null);
  const [transient, setTransient] = useState<ApiClientError | null>(null);
  const [paused, setPaused] = useState(false);
  const [otherTab, setOtherTab] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  const running = useRef(false);

  const loop = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setPaused(false);
    let failures = 0;
    const backoff = () => new Promise((res) => setTimeout(res, Math.min(15_000, 1000 * 2 ** failures)));
    try {
      // 1) Load the saved state (retrying temporary failures).
      let current: PublicScan | null = null;
      while (alive.current && !current) {
        try {
          current = await api<PublicScan>(`/api/scans/${id}`);
          setTransient(null);
        } catch (err) {
          const e = err as ApiClientError;
          if (isPermanentScanError(e)) return setFatal(e);
          failures++;
          setTransient(e);
          if (failures >= MAX_TRANSIENT_FAILURES) return setPaused(true);
          await backoff();
        }
      }
      if (!alive.current || !current) return;
      setScan(current);
      failures = 0;

      // 2) Drive the scan forward in bounded server steps until it finishes.
      while (alive.current && !TERMINAL.includes(current.status)) {
        // While a step runs (up to ~20 s), poll saved progress so the page reflects each completed batch.
        const poll = setInterval(() => {
          api<PublicScan>(`/api/scans/${id}`)
            .then((s) => alive.current && setScan((prev) => newer(prev, s)))
            .catch((error: ApiClientError) => {
              if (isPermanentScanError(error)) {
                clearInterval(poll);
                alive.current = false;
                setFatal(error);
              }
            });
        }, 2000);
        try {
          const r = await api<{ scan: PublicScan | null; leaseBusy: boolean }>(`/api/scans/${id}/advance`, { method: "POST", json: {} }).finally(() => clearInterval(poll));
          failures = 0;
          setTransient(null);
          if (!r.scan) break;
          current = r.scan;
          if (!alive.current) return;
          setScan((prev) => newer(prev, r.scan!));
          setOtherTab(r.leaseBusy);
          if (r.leaseBusy) await new Promise((res) => setTimeout(res, 2000));
        } catch (err) {
          const e = err as ApiClientError;
          if (isPermanentScanError(e)) return setFatal(e);
          failures++;
          setTransient(e);
          if (failures >= MAX_TRANSIENT_FAILURES) return setPaused(true);
          await backoff();
        }
      }
      if (alive.current && (current.status === "completed" || current.status === "completed_with_warnings")) {
        router.replace(`/scans/${id}`);
      }
    } finally {
      running.current = false;
    }
  }, [id, router]);

  useEffect(() => {
    alive.current = true;
    const start = setTimeout(() => void loop(), 0);
    const t = setInterval(() => setNow(Date.now()), 1000);
    const online = () => void loop(); // resume automatically when the connection returns
    window.addEventListener("online", online);
    return () => {
      alive.current = false;
      clearTimeout(start);
      clearInterval(t);
      window.removeEventListener("online", online);
    };
  }, [loop]);

  async function cancel() {
    if (!confirm("Cancel this audit? Partial data will not be turned into a report.")) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const s = await api<PublicScan>(`/api/scans/${id}/cancel`, { method: "POST", json: {} });
      setScan(s);
    } catch (e) {
      setCancelError((e as ApiClientError).message);
    } finally {
      setCancelling(false);
    }
  }

  if (fatal) return <ScanAccessError error={fatal} />;

  if (!scan) {
    if (paused && transient) return <ScanAccessError error={transient} onRetry={() => void loop()} />;
    return (
      <div className="container max-w-3xl space-y-6 py-10">
        <LoadingRegion label="Loading audit progress">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="mt-2 h-8 w-2/3" />
          <Card className="mt-6 space-y-4 p-6">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-2 w-full" />
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-5 w-1/2" />)}
          </Card>
        </LoadingRegion>
        {transient ? <p className="text-sm text-muted-foreground">Connection problem, retrying…</p> : null}
      </div>
    );
  }

  const phases = phasesFor(scan);
  const started = scan.startedAt ? Date.parse(scan.startedAt) : null;
  const elapsed = started ? (scan.finishedAt ? Date.parse(scan.finishedAt) : now) - started : 0;
  const terminal = TERMINAL.includes(scan.status);
  const currentIndex = phases.findIndex((p) => p.id === scan.phase);
  const pct = percent(scan, phases);

  return (
    <div className="container max-w-3xl space-y-6 py-10">
      <div>
        <p className="text-sm text-muted-foreground">{terminal ? "Audit" : "Auditing"}</p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="break-all text-2xl font-semibold tracking-tight">{scan.title || displayUrl(scan.targetUrl, 80)}</h1>
          <StatusBadge status={scan.status} />
        </div>
      </div>

      {scan.status === "failed" ? (
        <Alert tone="error" title="The audit couldn't be completed">
          {scan.error?.message ?? "The audit stopped before a report could be produced."}
        </Alert>
      ) : null}
      {scan.status === "cancelled" ? <Alert tone="warning" title="Audit cancelled">No report was produced.</Alert> : null}

      <Card className="p-5 sm:p-6" aria-busy={!terminal && !paused}>
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">{terminal ? "Finished" : scan.phase === "queued" ? "Starting…" : phases[currentIndex]?.label ?? "Working…"}</span>
          <span className="tabular-nums text-muted-foreground">
            {terminal ? null : `${pct}% · `}
            {formatDuration(elapsed)}
          </span>
        </div>
        <ProgressBar className="mt-3" value={pct} label="Audit progress" />
        {/* Announce phase changes and the outcome only — not every percentage tick. */}
        <p role="status" aria-live="polite" className="sr-only">
          {scan.status === "failed" ? "The audit couldn't be completed." : scan.status === "cancelled" ? "Audit cancelled." : terminal ? "Audit finished. Opening the report…" : `${phases[currentIndex]?.label ?? "Starting"}…`}
        </p>
        <ol className="mt-6 space-y-3">
          {phases.map((ph, i) => {
            const ok = scan.status !== "failed" && scan.status !== "cancelled";
            const done = terminal ? ok || i < currentIndex : currentIndex >= 0 && i < currentIndex;
            const current = !terminal && i === currentIndex;
            const detail = phaseDetail(scan, ph.id, done || current);
            return (
              <li key={ph.id} className="flex items-start gap-3">
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${done ? "border-success/30 bg-success text-white" : current ? "border-primary text-primary" : "text-muted-foreground"}`}
                  aria-hidden="true"
                >
                  {done ? "✓" : current ? <Spinner className="h-3 w-3" /> : i + 1}
                </span>
                <div>
                  <p className={`text-sm ${current ? "font-medium" : done ? "" : "text-muted-foreground"}`}>
                    {ph.label}
                    <span className="sr-only">{done ? " (done)" : current ? " (in progress)" : " (pending)"}</span>
                  </p>
                  {detail ? <p className="text-xs tabular-nums text-muted-foreground">{detail}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      </Card>

      <CrawlCounts scan={scan} />

      {scan.progress.recentUrls.length > 0 && !terminal ? (
        <Card className="p-5">
          <p className="text-sm font-medium">Recently checked</p>
          <ul className="mt-2 space-y-1">
            {scan.progress.recentUrls.map((u, i) => (
              <li key={`${u}-${i}`} className="truncate font-mono text-xs text-muted-foreground" title={u}>{u}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      {scan.warnings.length > 0 ? (
        <Alert tone="warning" title="Coverage notes">
          <ul className="list-disc space-y-1 pl-5">{scan.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </Alert>
      ) : null}

      {otherTab && !terminal ? <Alert tone="info">This audit is also running in another tab or window. Progress here updates automatically.</Alert> : null}
      {transient && !paused && !terminal ? <Alert tone="warning">Connection problem — retrying automatically…</Alert> : null}
      {paused && !terminal ? (
        <Alert tone="error" title="Audit paused">
          {transient?.message ?? "We couldn't reach the server."} Your progress is saved.
          <div className="mt-3"><Button size="sm" onClick={() => void loop()}>Resume audit</Button></div>
        </Alert>
      ) : null}
      {cancelError ? <Alert tone="error">{cancelError}</Alert> : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {!terminal ? (
          <p className="text-sm text-muted-foreground">
            {system?.background === "full"
              ? "You can leave this page — the audit keeps running on the server and will be in your audit list when it finishes."
              : system?.background === "limited"
                ? "The audit keeps running on the server for a while after you leave; if it pauses, it resumes when you reopen this page."
                : "Keep this page open while the audit runs. If you leave, it continues from where it stopped when you come back."}
          </p>
        ) : <div />}
        <div className="flex gap-2">
          {!terminal ? (
            <Button variant="outline" onClick={cancel} disabled={cancelling}>{cancelling ? <Spinner /> : null}Cancel audit</Button>
          ) : scan.hasResults ? (
            <ButtonLink href={`/scans/${id}`}>View report</ButtonLink>
          ) : (
            <>
              {scan.viewer?.canEdit === false ? null : <AuditOwnerActions scan={scan} onChanged={() => window.location.reload()} />}
              <ButtonLink href="/dashboard" variant="outline" size="sm">Dashboard</ButtonLink>
            </>
          )}
        </div>
      </div>
      {scan.status === "failed" ? <p className="text-sm text-muted-foreground">See <Link href="/help#limitations" className="text-primary hover:underline">known limitations</Link> for common causes.</p> : null}
    </div>
  );
}

/** Real crawl counters from the server. Only shown for audits that record them; nothing is estimated. */
function CrawlCounts({ scan }: { scan: PublicScan }) {
  const p = scan.progress;
  if (p.pagesRemaining === undefined && p.pagesFailed === undefined) return null;
  const limit = p.pagesLimit ?? scan.limits.maxPages;
  const items: Array<[string, number, string]> = [
    ["Discovered", p.pagesDiscovered, "Internal URLs found from links, sitemaps, redirects and canonicals"],
    ["Scanned", p.pagesCrawled, "Pages that returned a response and were analysed"],
    ["Remaining", p.pagesRemaining ?? 0, "Queued pages still to fetch within the page limit"],
    ["Skipped", p.pagesSkipped ?? 0, "Not fetched: robots.txt, page limit, depth, URL traps or duplicates"],
    ["No response", p.pagesFailed ?? 0, "Timeouts, DNS, connection or TLS failures after retries"],
  ];
  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Pages</p>
        <p className="text-xs tabular-nums text-muted-foreground">limit {limit} for this audit</p>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {items.map(([label, value, hint]) => (
          <div key={label} title={hint}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-display text-xl font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {(p.pagesHttpErrors ?? 0) > 0 ? <p className="mt-3 text-xs text-muted-foreground">{p.pagesHttpErrors} scanned page{p.pagesHttpErrors === 1 ? "" : "s"} answered with an HTTP error; they appear as findings in the report.</p> : null}
      {(p.pagesSkipped ?? 0) > 0 && scan.limits.maxPages <= p.pagesCrawled ? <p className="mt-1 text-xs text-muted-foreground">The site has more pages than this audit&apos;s limit. Larger plans can audit more pages per run.</p> : null}
    </Card>
  );
}
