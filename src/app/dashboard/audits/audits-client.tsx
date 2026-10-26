"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusBadge } from "@/components/badges";
import { useAuditActions } from "@/components/audit-actions";
import { AuditShareButton } from "@/components/audit-owner-actions";
import { DashboardNav } from "@/components/dashboard-nav";
import { InlineError } from "@/components/load-error";
import { TableSkeleton } from "@/components/skeletons";
import { Alert, Badge, Button, ButtonLink, Card, EmptyState, Input, LoadingRegion, PageHeader, Select, Spinner, buttonClass, cn } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { displayUrl, formatDateTime, formatRelative } from "@/lib/client/format";
import { useSession } from "@/lib/client/session";
import type { AuditListItem, AuditListResponse } from "@/lib/client/types";
import { auditHref, signInRedirect } from "../dashboard-client";

const STATUS = [
  ["all", "All statuses"],
  ["active", "In progress"],
  ["completed", "Completed"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
] as const;
const SORT = [
  ["newest", "Newest first"],
  ["oldest", "Oldest first"],
  ["score_desc", "Highest score"],
  ["score_asc", "Lowest score"],
  ["name", "Name (A–Z)"],
] as const;

function RowMenu({ a, onRename, onRerun, onDelete, onChanged, rerunning }: { a: AuditListItem; onRename: () => void; onRerun: () => void; onDelete: () => void; onChanged: () => void; rerunning: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        ref.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const terminal = a.status === "completed" || a.status === "failed" || a.status === "cancelled";
  const item = "block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted disabled:opacity-50";
  return (
    <div ref={ref} className="relative inline-block text-left">
      <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-lg hover:bg-muted" aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${a.title || a.hostname}`} onClick={() => setOpen((o) => !o)}>
        {rerunning ? <Spinner /> : (
          <svg viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor" aria-hidden="true"><circle cx="4" cy="10" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="16" cy="10" r="1.6" /></svg>
        )}
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-52 rounded-xl border bg-card p-1.5 shadow-xl">
          <Link role="menuitem" className={item} href={auditHref(a)} onClick={() => setOpen(false)}>{a.hasResults ? "Open report" : "View progress"}</Link>
          {a.mine ? <button role="menuitem" type="button" className={item} onClick={() => { setOpen(false); onRename(); }}>Rename</button> : null}
          {a.mine && terminal ? (
            <button role="menuitem" type="button" className={item} disabled={rerunning} onClick={() => { setOpen(false); onRerun(); }}>{a.status === "completed" ? "Run again" : "Retry"}</button>
          ) : null}
          {a.hasResults ? <a role="menuitem" className={item} href={`/api/scans/${a.id}/report.pdf`} onClick={() => setOpen(false)}>Export PDF</a> : null}
          {a.hasResults ? <Link role="menuitem" className={item} href={`/dashboard/compare?a=${a.id}`} onClick={() => setOpen(false)}>Compare…</Link> : null}
          {a.mine ? <AuditShareButton
            scanId={a.id}
            organizationId={a.organizationId}
            onChanged={onChanged}
            triggerLabel={a.organizationId ? "Manage team sharing" : "Share with a team"}
            triggerVariant="ghost"
            triggerSize="sm"
            triggerClassName={item}
            triggerRole="menuitem"
          /> : null}
          {a.mine ? <button role="menuitem" type="button" className={cn(item, "text-danger")} onClick={() => { setOpen(false); onDelete(); }}>Delete</button> : null}
        </div>
      ) : null}
    </div>
  );
}

export function AuditsClient() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { session } = useSession();
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "all";
  const sort = params.get("sort") ?? "newest";
  const scope = params.get("scope") ?? "mine";
  const page = Math.max(1, Number(params.get("page")) || 1);

  const [search, setSearch] = useState(q);
  const [data, setData] = useState<AuditListResponse | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);

  const setParams = useCallback(
    (next: Record<string, string | number | null>) => {
      const sp = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v === null || v === "" || (k === "page" && v === 1) || (k === "status" && v === "all") || (k === "sort" && v === "newest") || (k === "scope" && v === "mine")) sp.delete(k);
        else sp.set(k, String(v));
      }
      const s = sp.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  // Debounced search → URL.
  useEffect(() => {
    if (search === q) return;
    const t = setTimeout(() => setParams({ q: search.trim() || null, page: 1 }), 300);
    return () => clearTimeout(t);
  }, [search, q, setParams]);

  const query = useMemo(() => {
    const sp = new URLSearchParams({ status, sort, page: String(page), pageSize: "10", scope });
    if (q) sp.set("q", q);
    return sp.toString();
  }, [q, status, sort, page, scope]);

  const load = useCallback(() => {
    setLoading(true);
    api<AuditListResponse>(`/api/audits?${query}`)
      .then((d) => {
        if (d.items.length === 0 && d.page > 1 && d.total > 0) {
          setParams({ page: d.totalPages });
          return;
        }
        setData(d);
        setError(null);
      })
      .catch((e: ApiClientError) => {
        if (!signInRedirect(e)) setError(e);
      })
      .finally(() => setLoading(false));
  }, [query, setParams]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const hasActive = !!data?.items.some((a) => a.status === "queued" || a.status === "running");
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [hasActive, load]);

  const actions = useAuditActions({ onChanged: load, onDeleted: (id) => setSelected((s) => s.filter((x) => x !== id)) });
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 2 ? [s[1], id] : [...s, id]));
  const filtered = q || status !== "all";

  return (
    <div className="container space-y-6 py-8 sm:py-10">
      <PageHeader title="Audits" description={session?.user ? "Every audit saved to your account." : "Audits started in this browser."} action={<ButtonLink href="/audit/new">New audit</ButtonLink>} />
      <DashboardNav />
      {actions.dialogs}
      {actions.error ? <Alert tone="error">{actions.error}</Alert> : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <label className="relative flex-1 sm:min-w-[16rem]">
          <span className="sr-only">Search audits</span>
          <Input type="search" placeholder="Search by name or URL" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={100} />
        </label>
        <div className="grid grid-cols-2 gap-3 sm:flex">
          <label>
            <span className="sr-only">Status</span>
            <Select className="w-full" value={status} onChange={(e) => setParams({ status: e.target.value, page: 1 })}>
              {STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </label>
          <label>
            <span className="sr-only">Sort</span>
            <Select className="w-full" value={sort} onChange={(e) => setParams({ sort: e.target.value, page: 1 })}>
              {SORT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </label>
          {session?.user ? (
            <label className="col-span-2 sm:col-span-1">
              <span className="sr-only">Show</span>
              <Select className="w-full" value={scope} onChange={(e) => setParams({ scope: e.target.value, page: 1 })}>
                <option value="mine">My audits</option>
                <option value="all">Mine + shared with my teams</option>
              </Select>
            </label>
          ) : null}
        </div>
      </div>

      {selected.length ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 px-4 py-2.5 text-sm" role="status">
          <span>{selected.length === 1 ? "Select one more completed audit to compare." : "2 audits selected."}</span>
          {selected.length === 2 ? <Link href={`/dashboard/compare?a=${selected[0]}&b=${selected[1]}`} className={buttonClass("primary", "sm")}>Compare</Link> : null}
          <button type="button" className="font-medium text-muted-foreground hover:text-foreground" onClick={() => setSelected([])}>Clear</button>
        </div>
      ) : null}

      <Card>
        {error ? <InlineError error={error} what="your audits" onRetry={load} busy={loading} /> : null}
        {!data && loading ? (
          <LoadingRegion label="Loading audits"><TableSkeleton rows={6} className="border-0 shadow-none" /></LoadingRegion>
        ) : data && data.items.length === 0 ? (
          filtered ? (
            <EmptyState title="No audits match" action={<Button variant="outline" onClick={() => { setSearch(""); setParams({ q: null, status: null, page: 1 }); }}>Clear filters</Button>}>Try a different search or status.</EmptyState>
          ) : (
            <EmptyState title="No audits yet" action={<ButtonLink href="/audit/new">Start your first audit</ButtonLink>}>Audits you run are saved here so you can reopen, compare and export them.</EmptyState>
          )
        ) : data ? (
          <div className={cn("transition-opacity", loading && "opacity-60")} aria-busy={loading}>
            <table className="w-full text-sm">
              <caption className="sr-only">Audits, page {data.page} of {data.totalPages}</caption>
              <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="w-10 py-3 pl-4"><span className="sr-only">Select to compare</span></th>
                  <th className="px-3 py-3 font-medium">Audit</th>
                  <th className="hidden px-3 py-3 font-medium sm:table-cell">Status</th>
                  <th className="hidden px-3 py-3 text-right font-medium md:table-cell">Score</th>
                  <th className="hidden px-3 py-3 text-right font-medium md:table-cell">Issues</th>
                  <th className="hidden px-3 py-3 text-right font-medium lg:table-cell">Broken links</th>
                  <th className="hidden px-3 py-3 font-medium lg:table-cell">Started</th>
                  <th className="py-3 pr-4 text-right font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.items.map((a) => (
                  <tr key={a.id} className="align-top hover:bg-muted/30">
                    <td className="py-3 pl-4">
                      <input type="checkbox" className="mt-1 h-4 w-4" checked={selected.includes(a.id)} disabled={!a.hasResults} onChange={() => toggle(a.id)} aria-label={`Select ${a.title || a.hostname} to compare`} title={a.hasResults ? "Select to compare" : "Only completed audits can be compared"} />
                    </td>
                    <td className="max-w-0 px-3 py-3">
                      <Link href={auditHref(a)} className="block truncate font-medium hover:underline" title={a.targetUrl}>{a.title || displayUrl(a.targetUrl, 60)}</Link>
                      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                        <span className="min-w-0 truncate">{a.title ? displayUrl(a.targetUrl, 60) : a.hostname}{a.rerunOf ? " · re-run" : ""}</span>
                        <Badge className={a.organizationId ? "shrink-0 border-primary/20 bg-primary/5 text-primary" : "shrink-0 border-border bg-muted/40 text-muted-foreground"}>
                          {a.organizationId || !a.mine ? "Shared with team" : "Private"}
                        </Badge>
                      </p>
                      <div className="mt-1 sm:hidden"><StatusBadge status={a.status} /> <span className="text-xs text-muted-foreground">{formatRelative(a.createdAt)}{a.overallScore !== null ? ` · Score ${a.overallScore}` : ""}</span></div>
                      {a.status === "failed" && a.error ? <p className="mt-1 text-xs text-danger">{a.error.message}</p> : null}
                      {(a.status === "queued" || a.status === "running") ? <p className="mt-1 text-xs text-muted-foreground">{a.progress.pagesCrawled} of {Math.max(a.progress.pagesDiscovered, a.progress.pagesCrawled)} pages · {a.progress.linksChecked} links checked</p> : null}
                    </td>
                    <td className="hidden px-3 py-3 sm:table-cell"><StatusBadge status={a.status} /></td>
                    <td className="hidden px-3 py-3 text-right tabular-nums md:table-cell">{a.overallScore ?? "—"}</td>
                    <td className="hidden px-3 py-3 text-right tabular-nums md:table-cell">{a.totalFindings ?? "—"}</td>
                    <td className="hidden px-3 py-3 text-right tabular-nums lg:table-cell">{a.brokenLinks ?? "—"}</td>
                    <td className="hidden px-3 py-3 text-muted-foreground lg:table-cell"><time dateTime={a.createdAt} title={formatDateTime(a.createdAt)}>{formatRelative(a.createdAt)}</time></td>
                    <td className="py-2 pr-4 text-right">
                      <RowMenu a={a} rerunning={actions.rerunning === a.id} onRename={() => actions.rename(a)} onRerun={() => actions.rerun(a)} onDelete={() => actions.remove(a)} onChanged={load} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {data && data.total > 0 ? (
          <nav className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm" aria-label="Pagination">
            <p className="text-muted-foreground">
              {(data.page - 1) * data.pageSize + 1}–{Math.min(data.total, data.page * data.pageSize)} of {data.total}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={data.page <= 1 || loading} onClick={() => setParams({ page: data.page - 1 })}>Previous</Button>
              <span className="tabular-nums text-muted-foreground">Page {data.page} of {data.totalPages}</span>
              <Button variant="outline" size="sm" disabled={data.page >= data.totalPages || loading} onClick={() => setParams({ page: data.page + 1 })}>Next</Button>
            </div>
          </nav>
        ) : null}
      </Card>
    </div>
  );
}
