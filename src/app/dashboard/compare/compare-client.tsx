"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { SeverityBadge } from "@/components/badges";
import { DashboardNav } from "@/components/dashboard-nav";
import { InlineError } from "@/components/load-error";
import { TableSkeleton } from "@/components/skeletons";
import { Alert, ButtonLink, Card, CardHeader, EmptyState, LoadingRegion, PageHeader, Select, cn } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { displayUrl, formatDateTime } from "@/lib/client/format";
import type { AuditListItem, AuditListResponse, ComparePair, CompareResponse, CompareStatus } from "@/lib/client/types";
import { signInRedirect } from "../dashboard-client";

const STATUS_TEXT: Record<Exclude<CompareStatus, "compared">, string> = {
  not_evaluated_in_baseline: "Not evaluated in baseline",
  not_evaluated_in_latest: "Not evaluated in latest",
  not_evaluated: "Not evaluated",
  unavailable_in_baseline: "Unavailable in baseline",
  unavailable_in_latest: "Unavailable in latest",
  unavailable: "Unavailable",
};

const METRIC_LABELS: Record<string, string> = {
  lighthouse_performance_score: "Lighthouse performance score",
  category_score: "Performance category score",
  first_contentful_paint: "First Contentful Paint",
  largest_contentful_paint: "Largest Contentful Paint",
  total_blocking_time: "Total Blocking Time (lab)",
  cumulative_layout_shift: "Cumulative Layout Shift",
  speed_index: "Speed Index",
  interaction_to_next_paint: "Interaction to Next Paint (field)",
  time_to_first_byte: "Time to First Byte",
};

function fmt(v: number | null, unit: string) {
  if (v === null) return "—";
  if (unit === "ms") return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
  if (unit === "unitless") return v.toFixed(3);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Change with direction; colour reflects whether it is an improvement. */
function Delta({ p, better, unit = "count" }: { p: ComparePair; better: "higher" | "lower"; unit?: string }) {
  if (p.status !== "compared" || p.delta === null) return <span className="text-xs text-muted-foreground">{STATUS_TEXT[p.status as Exclude<CompareStatus, "compared">]}</span>;
  if (p.delta === 0) return <span className="text-muted-foreground">No change</span>;
  const good = better === "higher" ? p.delta > 0 : p.delta < 0;
  const sign = p.delta > 0 ? "+" : "−";
  const abs = Math.abs(p.delta);
  return (
    <span className={cn("font-medium tabular-nums", good ? "text-success" : "text-danger")}>
      <span aria-hidden="true">{p.delta > 0 ? "▲" : "▼"} </span>
      {sign}
      {fmt(abs, unit)}
      <span className="sr-only">{good ? " (better)" : " (worse)"}</span>
    </span>
  );
}

function PairRow({ label, p, better, unit, extra }: { label: ReactNode; p: ComparePair; better: "higher" | "lower"; unit?: string; extra?: ReactNode }) {
  return (
    <tr>
      <th scope="row" className="px-5 py-2.5 text-left font-medium">{label}{extra}</th>
      <td className="px-3 py-2.5 text-right tabular-nums">{fmt(p.baseline, unit ?? "count")}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{fmt(p.latest, unit ?? "count")}</td>
      <td className="px-5 py-2.5 text-right"><Delta p={p} better={better} unit={unit} /></td>
    </tr>
  );
}

function PairTable({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-5 py-2.5 text-left font-medium">Measure</th>
            <th className="px-3 py-2.5 text-right font-medium">Baseline</th>
            <th className="px-3 py-2.5 text-right font-medium">Latest</th>
            <th className="px-5 py-2.5 text-right font-medium">Change</th>
          </tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  );
}

const label = (a: AuditListItem) => `${a.title || a.hostname} — ${formatDateTime(a.createdAt)}${a.overallScore !== null ? ` (score ${a.overallScore})` : ""}`;

export function CompareClient() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const a = params.get("a") ?? "";
  const b = params.get("b") ?? "";
  const [options, setOptions] = useState<AuditListItem[] | null>(null);
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [loading, setLoading] = useState(false);

  const setPair = useCallback((na: string, nb: string) => {
    const sp = new URLSearchParams();
    if (na) sp.set("a", na);
    if (nb) sp.set("b", nb);
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  }, [pathname, router]);

  useEffect(() => {
    api<AuditListResponse>("/api/audits?status=completed&pageSize=50&scope=all")
      .then((d) => setOptions(d.items))
      .catch((e: ApiClientError) => {
        if (!signInRedirect(e)) setError(e);
      });
  }, []);

  // Only "a" given: default "b" to the previous completed audit of the same site.
  useEffect(() => {
    if (!options || !a || b) return;
    const base = options.find((o) => o.id === a);
    if (!base) return;
    const prev = options.filter((o) => o.id !== a && o.hostname === base.hostname).sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
    const older = prev.find((o) => o.createdAt < base.createdAt) ?? prev[0];
    if (older) setPair(a, older.id);
  }, [options, a, b, setPair]);

  const loadCompare = useCallback(() => {
    if (!a || !b || a === b) return;
    setLoading(true);
    setResult(null);
    api<CompareResponse>(`/api/scans/compare?a=${a}&b=${b}`)
      .then((r) => {
        setResult(r);
        setError(null);
      })
      .catch((e: ApiClientError) => {
        if (!signInRedirect(e)) setError(e);
      })
      .finally(() => setLoading(false));
  }, [a, b]);

  useEffect(() => {
    const t = setTimeout(loadCompare, 0);
    return () => clearTimeout(t);
  }, [loadCompare]);

  const opts = useMemo(() => options ?? [], [options]);

  return (
    <div className="container space-y-6 py-8 sm:py-10">
      <PageHeader title="Compare audits" description="See what changed between two completed audits. The older audit is the baseline." />
      <DashboardNav />

      <Card className="p-5">
        {options === null && !error ? (
          <LoadingRegion label="Loading audits"><div className="h-10 animate-pulse rounded bg-muted motion-reduce:animate-none" /></LoadingRegion>
        ) : opts.length < 2 ? (
          <EmptyState title="You need two completed audits" action={<ButtonLink href="/audit/new">Start an audit</ButtonLink>}>Run an audit of the same site again later (or use “Run again”) to compare results.</EmptyState>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {([["a", a, "First audit"], ["b", b, "Second audit"]] as const).map(([key, val, text]) => (
              <label key={key} className="block text-sm">
                <span className="font-medium">{text}</span>
                <Select className="mt-1.5 w-full" value={val} onChange={(e) => (key === "a" ? setPair(e.target.value, b) : setPair(a, e.target.value))}>
                  <option value="">Choose a completed audit…</option>
                  {opts.map((o) => (
                    <option key={o.id} value={o.id} disabled={o.id === (key === "a" ? b : a)}>{label(o)}</option>
                  ))}
                </Select>
              </label>
            ))}
          </div>
        )}
      </Card>

      {error ? <Card><InlineError error={error} what="this comparison" onRetry={loadCompare} busy={loading} /></Card> : null}
      {a && b && a === b ? <Alert tone="warning">Choose two different audits.</Alert> : null}
      {loading ? <LoadingRegion label="Comparing audits"><TableSkeleton rows={6} /></LoadingRegion> : null}

      {result ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {([["Baseline", result.baseline], ["Latest", result.latest]] as const).map(([t, sd]) => (
              <Card key={t} className="p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t}</p>
                <Link href={`/scans/${sd.id}`} className="mt-1 block truncate font-semibold hover:underline">{sd.title || displayUrl(sd.targetUrl, 60)}</Link>
                <p className="text-sm text-muted-foreground">{formatDateTime(sd.createdAt)} · {sd.pagesScanned ?? "—"} pages</p>
                <p className="mt-1 text-xs text-muted-foreground">Browser checks: {sd.checks.browserPages ? `${sd.checks.browserPages} pages` : "off"} · Accessibility: {sd.checks.accessibility ? "on" : "off"} · Performance: {sd.checks.performance.length ? sd.checks.performance.join(", ") : "off"}</p>
              </Card>
            ))}
          </div>

          {result.comparable.notes.length ? (
            <Alert tone="warning" title="Read these differences before comparing">
              <ul className="list-disc space-y-1 pl-5">{result.comparable.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            </Alert>
          ) : null}

          <Card>
            <CardHeader title="Scores" description="0–100, higher is better. The overall score averages the categories that were evaluated." />
            <PairTable caption="Score changes">
              <PairRow label={<strong>Overall</strong>} p={result.overall} better="higher" />
              {result.categories.map((c) => <PairRow key={c.category} label={c.label} p={c} better="higher" />)}
            </PairTable>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Issues" description={`${result.issues.baselineTotal} → ${result.issues.latestTotal} total · ${result.issues.persisting} still present`} />
              <PairTable caption="Issue counts by severity">
                {result.severity.map((s) => <PairRow key={s.severity} label={<span className="capitalize">{s.severity}</span>} p={s} better="lower" />)}
              </PairTable>
            </Card>
            <Card>
              <CardHeader title="Links" />
              <PairTable caption="Link check changes">
                <PairRow label="Broken links" p={result.links.broken} better="lower" />
                <PairRow label="Inconclusive" p={result.links.inconclusive} better="lower" />
                <PairRow label="Links checked" p={result.links.checked} better="higher" />
              </PairTable>
              {result.links.noLongerChecked || result.links.newlyChecked ? (
                <p className="border-t px-5 py-3 text-xs text-muted-foreground">
                  {result.links.noLongerChecked ? `${result.links.noLongerChecked} previously broken link${result.links.noLongerChecked === 1 ? " was" : "s were"} not checked in the latest audit, so ${result.links.noLongerChecked === 1 ? "it isn't" : "they aren't"} counted as fixed. ` : ""}
                  {result.links.newlyChecked ? `${result.links.newlyChecked} link${result.links.newlyChecked === 1 ? "" : "s"} were checked for the first time.` : ""}
                </p>
              ) : null}
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title={`New issues (${result.issues.addedCount})`} description="Found in the latest audit but not the baseline." />
              {result.issues.added.length ? (
                <ul className="divide-y">
                  {result.issues.added.map((f) => (
                    <li key={f.id} className="flex items-start gap-3 px-5 py-2.5">
                      <SeverityBadge severity={f.severity} className="mt-0.5 shrink-0" />
                      <div className="min-w-0">
                        <Link href={`/scans/${result.latest.id}/issues/${f.id}`} className="block truncate text-sm font-medium hover:underline">{f.title}</Link>
                        <p className="truncate text-xs text-muted-foreground">{displayUrl(f.affectedUrl, 70)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <EmptyState title="No new issues" />}
              {result.issues.addedCount > result.issues.added.length ? <p className="border-t px-5 py-2 text-xs text-muted-foreground">Showing {result.issues.added.length} of {result.issues.addedCount}.</p> : null}
            </Card>
            <Card>
              <CardHeader title={`Resolved issues (${result.issues.fixedCount})`} description="In the baseline but not found in the latest audit." />
              {result.issues.fixed.length ? (
                <ul className="divide-y">
                  {result.issues.fixed.map((f) => (
                    <li key={f.id} className="flex items-start gap-3 px-5 py-2.5">
                      <SeverityBadge severity={f.severity} className="mt-0.5 shrink-0" />
                      <div className="min-w-0">
                        <Link href={`/scans/${result.baseline.id}/issues/${f.id}`} className="block truncate text-sm font-medium hover:underline">{f.title}</Link>
                        <p className="truncate text-xs text-muted-foreground">{displayUrl(f.affectedUrl, 70)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <EmptyState title="No resolved issues" />}
              {result.issues.fixedCount > result.issues.fixed.length ? <p className="border-t px-5 py-2 text-xs text-muted-foreground">Showing {result.issues.fixed.length} of {result.issues.fixedCount}.</p> : null}
            </Card>
          </div>

          {result.links.newlyBroken.length || result.links.fixed.length ? (
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader title={`Newly broken links (${result.links.newlyBrokenCount})`} />
                {result.links.newlyBroken.length ? <ul className="divide-y text-sm">{result.links.newlyBroken.map((u) => <li key={u} className="truncate px-5 py-2" title={u}>{displayUrl(u, 80)}</li>)}</ul> : <EmptyState title="None" />}
              </Card>
              <Card>
                <CardHeader title={`Fixed links (${result.links.fixedCount})`} description="Re-checked and no longer broken." />
                {result.links.fixed.length ? <ul className="divide-y text-sm">{result.links.fixed.map((u) => <li key={u} className="truncate px-5 py-2" title={u}>{displayUrl(u, 80)}</li>)}</ul> : <EmptyState title="None" />}
              </Card>
            </div>
          ) : null}

          <Card>
            <CardHeader title="Performance metrics" description="Google PageSpeed lab data and Chrome UX Report field data, where each audit has it." />
            {result.metrics.length ? (
              <PairTable caption="Performance metric changes">
                {result.metrics.map((m) => (
                  <PairRow
                    key={m.key}
                    label={METRIC_LABELS[m.metric] ?? m.metric.replace(/_/g, " ")}
                    extra={<span className="ml-2 text-xs font-normal text-muted-foreground">{m.strategy ? `${m.strategy} · ` : ""}{m.source === "crux_field" ? "field" : "lab"}</span>}
                    p={m}
                    unit={m.unit}
                    better={m.unit === "score" ? "higher" : "lower"}
                  />
                ))}
              </PairTable>
            ) : (
              <EmptyState title="No comparable performance data">Performance must be tested in both audits for metrics to be compared.</EmptyState>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
