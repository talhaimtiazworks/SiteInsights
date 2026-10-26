"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { SeverityBadge, StatusBadge } from "@/components/badges";
import { DashboardNav } from "@/components/dashboard-nav";
import { InlineError } from "@/components/load-error";
import { StatCardsSkeleton, TableSkeleton } from "@/components/skeletons";
import { SystemNotice } from "@/components/system-notice";
import { Alert, Button, ButtonLink, Card, CardHeader, EmptyState, LoadingRegion, PageHeader, ProgressBar, Spinner, Stat } from "@/components/ui";
import { UrlForm } from "@/components/url-form";
import { FeedbackInvite } from "@/components/feedback-invite";
import { api, ApiClientError } from "@/lib/client/api";
import { displayUrl, formatDateTime, formatRelative } from "@/lib/client/format";
import { useSession } from "@/lib/client/session";
import type { AuditListItem, AuditListResponse, DashboardResponse, Severity } from "@/lib/client/types";
import { toSignIn } from "@/lib/client/navigate";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const SEV_COLOR: Record<Severity, string> = { critical: "bg-danger", high: "bg-brand-orange", medium: "bg-brand-amber", low: "bg-info", info: "bg-muted" };

export function auditHref(a: { id: string; hasResults: boolean }) {
  return a.hasResults ? `/scans/${a.id}` : `/scans/${a.id}/progress`;
}

function activityText(e: DashboardResponse["activity"][number]): string {
  switch (e.event) {
    case "created":
      return e.detail.rerun_of ? "Re-run started" : "Audit started";
    case "status_changed":
      return e.toStatus === "completed" ? "Audit completed" : e.toStatus === "failed" ? "Audit failed" : e.toStatus === "cancelled" ? "Audit cancelled" : e.toStatus === "running" ? "Audit running" : `Status: ${e.toStatus ?? "updated"}`;
    case "renamed":
      return e.detail.title ? `Renamed to “${e.detail.title}”` : "Name cleared";
    case "issue_status_changed":
      return `Issue marked ${String(e.toStatus ?? "").replace(/_/g, " ")}`;
    case "shared":
      return "Shared with organization";
    case "unshared":
      return "Stopped sharing";
  }
}

function signInRedirect(e: ApiClientError) {
  if (e.status === 401 && (e.code === "auth_required" || e.code === "session_expired")) {
    toSignIn(e.code === "session_expired" ? "expired" : undefined);
    return true;
  }
  return false;
}
export { signInRedirect };

export function DashboardClient() {
  const { session } = useSession();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [recent, setRecent] = useState<AuditListItem[] | null>(null);
  const [active, setActive] = useState<AuditListItem[]>([]);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [claimMsg, setClaimMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api<DashboardResponse>("/api/dashboard"), api<AuditListResponse>("/api/audits?pageSize=6"), api<AuditListResponse>("/api/audits?status=active&pageSize=5")])
      .then(([d, r, a]) => {
        setData(d);
        setRecent(r.items);
        setActive(a.items);
        setError(null);
      })
      .catch((e: ApiClientError) => {
        if (!signInRedirect(e)) setError(e);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  // Keep live counts fresh while audits are running (real server state, polled).
  useEffect(() => {
    if (!active.length) return;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [active.length, load]);

  const claim = async () => {
    setClaiming(true);
    setClaimMsg(null);
    try {
      const r = await api<{ moved: number }>("/api/account/claim", { method: "POST", json: {} });
      setClaimMsg({ tone: "success", text: `Added ${r.moved} audit${r.moved === 1 ? "" : "s"} to your account.` });
      load();
    } catch (e) {
      setClaimMsg({ tone: "error", text: (e as ApiClientError).message });
    } finally {
      setClaiming(false);
    }
  };

  const s = data?.stats;
  const sevTotal = s ? SEVERITIES.reduce((a, k) => a + (s.severity[k] ?? 0), 0) : 0;
  const u = data?.usage;
  const name = session?.user?.displayName?.split(" ")[0];

  return (
    <div className="container space-y-6 py-8 sm:py-10">
      <FeedbackInvite />
      <PageHeader
        title={name ? `Welcome back, ${name}` : "Dashboard"}
        description={session?.user ? "Your audits, issues and usage at a glance." : "Audits started in this browser."}
        action={
          <div className="flex gap-2">
            {session?.user ? <ButtonLink href="/billing" variant="ghost">Account &amp; history</ButtonLink> : null}
            <ButtonLink href="/dashboard/audits" variant="outline">All audits</ButtonLink>
          </div>
        }
      />
      <DashboardNav />

      <Card className="p-5">
        <p className="mb-3 text-sm font-medium">Audit a website</p>
        <UrlForm />
      </Card>
      <SystemNotice />

      {data && data.claimable > 0 ? (
        <Alert tone="info" title={`${data.claimable} audit${data.claimable === 1 ? "" : "s"} from this browser`}>
          You ran {data.claimable === 1 ? "an audit" : "audits"} here before signing in. Add {data.claimable === 1 ? "it" : "them"} to your account to keep {data.claimable === 1 ? "it" : "them"} with your history.
          <div className="mt-2">
            <Button size="sm" onClick={claim} disabled={claiming}>
              {claiming ? <Spinner /> : null}
              Add to my account
            </Button>
          </div>
        </Alert>
      ) : null}
      {claimMsg ? <Alert tone={claimMsg.tone}>{claimMsg.text}</Alert> : null}

      {active.length ? (
        <Alert tone="info" title={active.length === 1 ? "Audit in progress" : `${active.length} audits in progress`}>
          <ul className="mt-1 space-y-1">
            {active.map((a) => (
              <li key={a.id}>
                {a.title || displayUrl(a.targetUrl, 50)} — {a.progress.pagesCrawled} page{a.progress.pagesCrawled === 1 ? "" : "s"} crawled · <Link className="font-medium underline" href={`/scans/${a.id}/progress`}>view progress</Link>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs opacity-80">Audits keep running on the server if you close this tab.</p>
        </Alert>
      ) : null}

      {error ? <Card><InlineError error={error} what="your dashboard" onRetry={load} busy={loading} /></Card> : null}

      <section aria-labelledby="stats-heading">
        <h2 id="stats-heading" className="sr-only">Summary</h2>
        {!s && loading ? (
          <LoadingRegion label="Loading statistics"><StatCardsSkeleton count={5} /></LoadingRegion>
        ) : s ? (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
            <Stat label="Total audits" value={s.total} hint={`${s.sites} site${s.sites === 1 ? "" : "s"}`} />
            <Stat label="Completed" value={s.completed} />
            <Stat label="Running" value={s.running} hint={s.running ? "Updating live" : "None right now"} />
            <Stat label="Failed" value={s.failed} hint={s.cancelled ? `${s.cancelled} cancelled` : undefined} />
            <Stat
              label="Average score"
              value={s.averageScore === null ? "—" : Math.round(s.averageScore)}
              hint={s.averageScore === null ? "No scored audits yet" : `Latest audit of ${s.scoredSites} site${s.scoredSites === 1 ? "" : "s"}`}
            />
          </div>
        ) : null}
      </section>

      <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
        <Card className="lg:col-span-2">
          <CardHeader title="Open issues by severity" description="From the latest completed audit of each site." />
          <div className="p-5">
            {!s ? (
              <div className="h-16 animate-pulse rounded bg-muted motion-reduce:animate-none" aria-hidden="true" />
            ) : s.completed === 0 ? (
              <p className="text-sm text-muted-foreground">Complete an audit to see issue severity here.</p>
            ) : sevTotal === 0 ? (
              <p className="text-sm text-muted-foreground">No open critical, high, medium or low issues. Nice work.</p>
            ) : (
              <>
                <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={SEVERITIES.map((k) => `${s.severity[k] ?? 0} ${k}`).join(", ")}>
                  {SEVERITIES.map((k) => (s.severity[k] ? <div key={k} className={SEV_COLOR[k]} style={{ width: `${(100 * s.severity[k]) / sevTotal}%` }} /> : null))}
                </div>
                <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {SEVERITIES.map((k) => (
                    <li key={k} className="flex items-center gap-2 text-sm">
                      <span className={`h-2.5 w-2.5 rounded-full ${SEV_COLOR[k]}`} aria-hidden="true" />
                      <span className="capitalize text-muted-foreground">{k}</span>
                      <span className="ml-auto font-semibold tabular-nums">{s.severity[k] ?? 0}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Usage" action={<Link href={session?.user ? "/account/usage" : "/usage"} className="text-sm font-medium text-primary hover:underline">Details</Link>} />
          <div className="space-y-4 p-5">
            {!u ? (
              <div className="h-24 animate-pulse rounded bg-muted motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <>
                <p className="text-sm">
                  Access: <strong>Free for everyone</strong>
                </p>
                {[
                  ["Audits", u.usage.scans],
                  ["AI requests", u.usage.ai],
                ].map(([label, d]) => {
                  const dd = d as typeof u.usage.scans;
                  return (
                    <div key={label as string}>
                      <div className="flex justify-between text-sm">
                        <span>{label as string}</span>
                        <span className="tabular-nums text-muted-foreground">{dd.used} / {dd.limit}</span>
                      </div>
                      <ProgressBar className="mt-1.5" value={dd.limit ? (100 * dd.used) / dd.limit : 100} label={`${label} used`} />
                      <p className="mt-1 text-xs text-muted-foreground">{dd.resetAt ? `${dd.remaining === 0 ? "Next allowance" : "Oldest use resets"} ${formatDateTime(dd.resetAt)}` : "Nothing used in the current window."}</p>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader title="Latest issues" description="Highest-severity open issues from your most recent audits." />
          {!data && loading ? (
            <LoadingRegion label="Loading issues"><TableSkeleton rows={4} className="border-0 shadow-none" /></LoadingRegion>
          ) : data && data.latestIssues.length === 0 ? (
            <EmptyState title="No open issues">Issues from completed audits appear here.</EmptyState>
          ) : data ? (
            <ul className="divide-y">
              {data.latestIssues.map((i) => (
                <li key={`${i.scanId}-${i.finding.id}`} className="flex items-start gap-3 px-5 py-3">
                  <SeverityBadge severity={i.finding.severity} className="mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <Link href={`/scans/${i.scanId}/issues/${i.finding.id}`} className="block truncate text-sm font-medium hover:underline">{i.finding.title}</Link>
                    <p className="truncate text-xs text-muted-foreground">{i.scanTitle || i.hostname} · {displayUrl(i.finding.affectedUrl, 60)}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>

        <Card>
          <CardHeader title="Recent activity" />
          {!data && loading ? (
            <LoadingRegion label="Loading activity"><TableSkeleton rows={4} className="border-0 shadow-none" /></LoadingRegion>
          ) : data && data.activity.length === 0 ? (
            <EmptyState title="No activity yet">Start an audit to see its history here.</EmptyState>
          ) : data ? (
            <ol className="divide-y">
              {data.activity.map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{activityText(e)}</p>
                    <Link href={`/scans/${e.scanId}`} className="block truncate text-xs text-muted-foreground hover:underline">{e.scanTitle || e.hostname || "Deleted audit"}</Link>
                  </div>
                  <time dateTime={e.createdAt} title={formatDateTime(e.createdAt)} className="shrink-0 text-xs text-muted-foreground">{formatRelative(e.createdAt)}</time>
                </li>
              ))}
            </ol>
          ) : null}
        </Card>
      </div>

      <Card>
        <CardHeader title="Recent audits" action={<Link href="/dashboard/audits" className="text-sm font-medium text-primary hover:underline">View all</Link>} />
        {recent === null && loading ? (
          <LoadingRegion label="Loading recent audits"><TableSkeleton rows={4} className="border-0 shadow-none" /></LoadingRegion>
        ) : recent && recent.length === 0 ? (
          <EmptyState title="No audits yet">Enter a URL above to run your first audit.</EmptyState>
        ) : recent ? (
          <ul className="divide-y">
            {recent.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <Link href={auditHref(a)} className="block truncate text-sm font-medium hover:underline" title={a.targetUrl}>{a.title || displayUrl(a.targetUrl, 56)}</Link>
                  <p className="text-xs text-muted-foreground">{formatRelative(a.createdAt)}{a.overallScore !== null ? ` · Score ${a.overallScore}` : ""}{a.totalFindings !== null ? ` · ${a.totalFindings} issues` : ""}</p>
                </div>
                <StatusBadge status={a.status} />
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </div>
  );
}
