"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DashboardNav } from "@/components/dashboard-nav";
import { InlineError } from "@/components/load-error";
import { TableSkeleton } from "@/components/skeletons";
import { Alert, Button, ButtonLink, Card, CardHeader, EmptyState, Input, PageHeader, Select, Spinner, buttonClass, cn } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { displayUrl, formatDate } from "@/lib/client/format";
import type { OrganizationSummary, ProspectInfo, ProspectsResponse, ProspectStatus } from "@/lib/client/types";

type TeamMemberOption = { userId: string; email: string | null; displayName: string | null; role: "owner" | "admin" | "member" };
type TeamMemberWithOrganization = TeamMemberOption & { organizationId: string };
type TeamOption = OrganizationSummary & { members: TeamMemberOption[] };

const STATUSES: Array<{ id: ProspectStatus; label: string }> = [
  { id: "new", label: "New" },
  { id: "reviewing", label: "Reviewing" },
  { id: "contacted", label: "Contacted" },
  { id: "converted", label: "Converted" },
];
const STATUS_STYLE: Record<ProspectStatus, string> = {
  new: "border-primary/25 bg-blue-soft text-primary",
  reviewing: "border-brand-amber/40 bg-gold-soft text-warning",
  contacted: "border-border bg-muted text-foreground",
  converted: "border-success/30 bg-success-soft text-success",
};

function parseStatus(v: string | null): ProspectStatus | "all" {
  return STATUSES.some((s) => s.id === v) ? (v as ProspectStatus) : "all";
}

export function ProspectsClient() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const status = parseStatus(params.get("status"));
  const [q, setQ] = useState(params.get("q") ?? "");
  const [data, setData] = useState<ProspectsResponse | null>(null);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ProspectInfo | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [manualWebsite, setManualWebsite] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualLocation, setManualLocation] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualMessage, setManualMessage] = useState<string | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const search = params.get("q") ?? "";
  const page = Math.max(0, Number.parseInt(params.get("page") ?? "0", 10) || 0);
  const pageSize = 50;

  const load = useCallback(() => {
    setBusy(true);
    const sp = new URLSearchParams({ status, limit: String(pageSize), offset: String(page * pageSize) });
    if (search) sp.set("q", search);
    api<ProspectsResponse>(`/api/prospects?${sp}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch(setError)
      .finally(() => setBusy(false));
  }, [status, search, page]);

  const loadTeams = useCallback(async () => {
    setTeamsError(null);
    try {
      const { organizations, members } = await api<{ organizations: OrganizationSummary[]; members: TeamMemberWithOrganization[] }>("/api/organizations?includeMembers=true");
      const byOrganization = new Map<string, TeamMemberOption[]>();
      for (const member of members) {
        const options = byOrganization.get(member.organizationId) ?? [];
        options.push({ userId: member.userId, email: member.email, displayName: member.displayName, role: member.role });
        byOrganization.set(member.organizationId, options);
      }
      setTeams(organizations.map((team) => ({ ...team, members: byOrganization.get(team.id) ?? [] })));
    } catch (e) {
      setTeams([]);
      setTeamsError((e as ApiClientError).message || "Team choices could not be loaded.");
    }
  }, []);
  useEffect(() => {
    if (!data?.canEdit) return;
    const t = setTimeout(() => { void loadTeams(); }, 0);
    return () => clearTimeout(t);
  }, [data?.canEdit, loadTeams]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const setParam = useCallback((key: string, value: string | null) => {
    const sp = new URLSearchParams(params);
    if (value) sp.set(key, value);
    else sp.delete(key);
    if (key !== "page") sp.delete("page");
    router.replace(`${pathname}${sp.size ? `?${sp}` : ""}`, { scroll: false });
  }, [params, router, pathname]);

  const total = data?.total;
  useEffect(() => {
    const lastPage = Math.max(0, Math.ceil((total ?? 0) / pageSize) - 1);
    if (total !== undefined && page > lastPage) setParam("page", lastPage ? String(lastPage) : null);
  }, [total, page, setParam]);

  const replace = (p: ProspectInfo) => setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === p.id ? p : x)) } : d));
  const totalAll = data ? Object.values(data.byStatus).reduce((a, b) => a + b, 0) : 0;
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));
  const addManual = async (e: FormEvent) => {
    e.preventDefault();
    setManualBusy(true); setManualError(null); setManualMessage(null);
    try {
      const result = await api<{ prospect: ProspectInfo; created: boolean }>("/api/prospects", { method: "POST", json: { websiteUrl: manualWebsite, businessName: manualName.trim() || null, location: manualLocation.trim() || null } });
      setManualWebsite(""); setManualName(""); setManualLocation("");
      setManualMessage(result.created ? "Prospect added. Add a completed audit later to attach verified findings." : "Existing prospect updated with the details you entered.");
      setParam("page", null); load();
    } catch (e) { setManualError((e as ApiClientError).message); }
    finally { setManualBusy(false); }
  };
  const importCsv = async (file: File | undefined) => {
    if (!file) return;
    setManualError(null); setManualMessage(null);
    if (file.size > 100_000) { setManualError("CSV must be 100 KB or smaller."); return; }
    setImportBusy(true);
    try {
      const result = await api<{ imported: number; created: number; updated: number; duplicatesSkipped: number }>("/api/prospects/import", { method: "POST", json: { csv: await file.text() } });
      setManualMessage(`Imported ${result.imported} prospects (${result.created} new, ${result.updated} updated${result.duplicatesSkipped ? `, ${result.duplicatesSkipped} duplicate rows skipped` : ""}).`);
      setParam("page", null); load();
    } catch (e) { setManualError((e as ApiClientError).message); }
    finally { setImportBusy(false); }
  };

  return (
    <div className="container space-y-6 py-8 sm:py-10">
      <PageHeader
        title="Prospects"
        description="Track websites for manual follow-up. Add prospects yourself or import a CSV; audited sites can be enriched with verified findings. Nothing is scraped, contacted or sent automatically."
        action={data && totalAll > 0 ? <a href={`/api/prospects/export?status=${status}`} className={buttonClass("outline")} download>Export CSV</a> : undefined}
      />
      <DashboardNav />

      {data && !data.canEdit ? (
        <Alert tone="info" title="Prospect editing is disabled on this deployment">
          {totalAll > 0
            ? "Your saved prospects stay readable, exportable and deletable, but adding or editing them is not available right now."
            : "Save audited sites as prospects, track status and notes, and export them for your own outreach."}{" "}
        </Alert>
      ) : null}

      {data?.canEdit && teamsError ? (
        <Alert tone="warning" title="Team sharing choices are unavailable">
          <div className="flex flex-wrap items-center gap-2">
            <span>{teamsError}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadTeams()}>Retry team list</Button>
          </div>
        </Alert>
      ) : null}

      {data?.canEdit ? (
        <Card>
          <CardHeader title="Add a prospect manually" description="Enter a public website URL and any details you know. URLs are validated before saving; the site is not contacted until you choose to run an audit." />
          <div className="space-y-4 p-5">
            {manualError ? <Alert tone="error">{manualError}</Alert> : null}
            {manualMessage ? <Alert tone="success">{manualMessage}</Alert> : null}
            <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={addManual}>
              <label className="text-sm font-medium lg:col-span-2">Website URL<Input type="url" required value={manualWebsite} onChange={(e) => setManualWebsite(e.target.value)} maxLength={2048} placeholder="https://example.com" className="mt-1" /></label>
              <label className="text-sm font-medium">Business name (optional)<Input value={manualName} onChange={(e) => setManualName(e.target.value)} maxLength={160} className="mt-1" /></label>
              <label className="text-sm font-medium">Location (optional)<Input value={manualLocation} onChange={(e) => setManualLocation(e.target.value)} maxLength={160} className="mt-1" /></label>
              <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-4">
                <Button type="submit" size="sm" disabled={manualBusy}>{manualBusy ? <><Spinner /> Adding…</> : "Add prospect"}</Button>
                <label className={buttonClass("outline", "sm", "cursor-pointer")}>{importBusy ? <><Spinner /> Importing…</> : "Import CSV"}<input type="file" accept=".csv,text/csv" className="sr-only" disabled={importBusy} onChange={(e) => { void importCsv(e.target.files?.[0]); e.currentTarget.value = ""; }} /></label>
                <span className="text-xs text-muted-foreground">CSV columns: Website (or URL), Business name, Location. Maximum 100 rows and 100 KB.</span>
              </div>
            </form>
          </div>
        </Card>
      ) : null}

      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div role="group" aria-label="Filter prospects by status" className="flex min-w-0 gap-1 overflow-x-auto">
          {[{ id: "all" as const, label: "All" }, ...STATUSES].map((s) => {
            const count = data ? (s.id === "all" ? totalAll : data.byStatus[s.id] ?? 0) : null;
            const active = status === s.id;
            return (
              <button key={s.id} type="button" aria-pressed={active} onClick={() => setParam("status", s.id === "all" ? null : s.id)} className={cn("shrink-0 whitespace-nowrap rounded-md border px-3 py-1.5 text-sm font-medium", active ? "border-primary bg-primary text-white" : "border-border bg-card text-muted-foreground hover:text-foreground")}>
                {s.label}{count !== null ? <span className="ml-1.5 tabular-nums opacity-80">{count}</span> : null}
              </button>
            );
          })}
        </div>
        <form className="flex min-w-0 gap-2" onSubmit={(e) => { e.preventDefault(); setParam("q", q.trim() || null); }}>
          <label htmlFor="prospect-search" className="sr-only">Search prospects</label>
          <Input id="prospect-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search site or notes" className="h-9 min-w-0 flex-1 md:w-64" maxLength={200} />
          <Button type="submit" variant="outline" size="sm">Search</Button>
        </form>
      </div>

      {error ? <Card><InlineError error={error} what="your prospects" onRetry={load} busy={busy} /></Card> : null}
      {!data && !error ? <div role="status" aria-live="polite" aria-busy="true"><span className="sr-only">Loading prospects</span><TableSkeleton rows={4} /></div> : null}
      {data && data.items.length === 0 ? (
        <EmptyState title={search || status !== "all" ? "No prospects match this filter" : "No prospects yet"} action={search || status !== "all" ? <Button variant="outline" onClick={() => router.replace(pathname)}>Clear filters</Button> : <ButtonLink href="/dashboard/audits">Open your audits</ButtonLink>}>
          {search || status !== "all" ? "Try another status or search term." : "Add a prospect manually or import a CSV. When you later save a finished audit for the same website, its verified findings are attached to that prospect."}
        </EmptyState>
      ) : null}

      {data && data.items.length > 0 ? (
        <ul className="space-y-3" aria-label="Prospects">
          {data.items.map((p) => (
            <ProspectRow key={p.id} p={p} canEdit={data.canEdit} teams={teams} onSaved={replace} onDelete={() => { setDeleteError(null); setPendingDelete(p); }} />
          ))}
        </ul>
      ) : null}
      {data ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <p>Showing {data.total ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, data.total)} of ` : ""}{data.total}{data.canEdit ? ` · the list stores up to ${data.limit} prospects` : ""}. Contact details are only what you enter yourself; SiteInsights does not collect or guess them.</p>
          {totalPages > 1 ? <nav aria-label="Prospect pages" className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={page <= 0 || busy} onClick={() => setParam("page", String(page - 1))}>Previous</Button><span>Page {page + 1} of {totalPages}</span><Button size="sm" variant="outline" disabled={page + 1 >= totalPages || busy} onClick={() => setParam("page", String(page + 1))}>Next</Button></nav> : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete prospect?"
        confirmLabel="Delete prospect"
        busy={deleting}
        error={deleteError}
        onClose={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          setDeleting(true);
          try {
            await api(`/api/prospects/${pendingDelete.id}`, { method: "DELETE" });
            setPendingDelete(null);
            load();
          } catch (e) {
            setDeleteError((e as ApiClientError).message);
          } finally {
            setDeleting(false);
          }
        }}
      >
        {pendingDelete ? <>This permanently removes <strong>{pendingDelete.hostname}</strong> and its team share, status, and notes from your account. The audit itself is kept.</> : null}
      </ConfirmDialog>
    </div>
  );
}

function ProspectRow({ p, canEdit, teams, onSaved, onDelete }: { p: ProspectInfo; canEdit: boolean; teams: TeamOption[]; onSaved: (p: ProspectInfo) => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState(p.organizationId ?? "");
  const [shareConfirm, setShareConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ businessName: p.businessName ?? "", location: p.location ?? "", notes: p.notes ?? "", contactName: p.contactName ?? "", contactEmail: p.contactEmail ?? "", contactUrl: p.contactUrl ?? "" });
  const team = teams.find((t) => t.id === p.organizationId);
  const canManageAssignment = !!p.canManageSharing || team?.role === "owner" || team?.role === "admin";
  const ev = p.evidence;
  const severe = ev ? (ev.findingsBySeverity.critical ?? 0) + (ev.findingsBySeverity.high ?? 0) : 0;

  const patch = async (body: Record<string, unknown>, what: string) => {
    setSaving(what);
    setError(null);
    try {
      const r = await api<{ prospect: ProspectInfo }>(`/api/prospects/${p.id}`, { method: "PATCH", json: body });
      onSaved(r.prospect);
      setShareTarget(r.prospect.organizationId ?? "");
      return true;
    } catch (e) {
      setError((e as ApiClientError).message);
      return false;
    } finally {
      setSaving(null);
    }
  };

  return (
    <li>
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate font-display text-lg font-semibold">{p.businessName || p.hostname}</h2>
              <span className={cn("rounded-md border px-2 py-0.5 text-xs font-medium", STATUS_STYLE[p.status])}>{STATUSES.find((s) => s.id === p.status)?.label}</span>
              {p.organizationId ? <span className="rounded-md border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs text-primary">Shared with {p.organizationName || "a team"}</span> : <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">Private</span>}
            </div>
            <p className="mt-0.5 break-words text-sm text-muted-foreground">
              {p.businessName ? <><span>{p.hostname}</span> · </> : null}<a href={p.websiteUrl} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline">{displayUrl(p.websiteUrl)}</a>
              {p.location ? <> · {p.location}</> : null}
              {p.auditedAt ? <> · audited {formatDate(p.auditedAt)}</> : null}
              {p.assignedToUserId ? <> · assigned to {p.assignedToName || p.assignedToEmail || "a teammate"}</> : null}
              {p.auditId ? <> · <Link href={`/scans/${p.auditId}`} className="text-primary hover:underline">view audit</Link></> : <> · audit no longer available</>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <label htmlFor={`status-${p.id}`} className="sr-only">Status for {p.hostname}</label>
            <Select id={`status-${p.id}`} value={p.status} disabled={!canEdit || saving !== null} onChange={(e) => patch({ status: e.target.value }, "status")} className="h-9 w-36">
              {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </Select>
            {saving === "status" ? <Spinner /> : null}
          </div>
        </div>

        {ev ? (
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-4 text-sm sm:grid-cols-4">
            <div><dt className="text-xs text-muted-foreground">Overall score</dt><dd className="font-medium tabular-nums">{ev.overallScore ?? "Not scored"}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Pages scanned</dt><dd className="font-medium tabular-nums">{ev.pagesScanned}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Critical / high findings</dt><dd className="font-medium tabular-nums">{severe} of {ev.totalFindings}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Broken links</dt><dd className="font-medium tabular-nums">{ev.brokenLinks}</dd></div>
          </dl>
        ) : null}
        {ev && ev.topIssues.length ? (
          <div className="mt-3 text-sm">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Verified findings from the audit</p>
            <ul className="mt-1 space-y-0.5">
              {ev.topIssues.slice(0, 3).map((t) => <li key={t.title}><span className="capitalize text-muted-foreground">{t.severity}</span> · {t.title} <span className="text-muted-foreground tabular-nums">({t.affectedCount} affected)</span></li>)}
            </ul>
          </div>
        ) : ev ? <p className="mt-3 text-sm text-muted-foreground">The audit found no significant issues. Use the strengths in the report as a reason to stay in touch rather than a problem to sell.</p> : null}

        {p.notes && !open ? <p className="mt-3 whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-sm">{p.notes}</p> : null}
        {(p.contactName || p.contactEmail || p.contactUrl) && !open ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Contact: {[p.contactName, p.contactEmail].filter(Boolean).join(" · ")}
            {p.contactUrl ? <> · <a href={p.contactUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-primary hover:underline">{displayUrl(p.contactUrl)}</a></> : null}
          </p>
        ) : null}

        {(canEdit && p.canManageSharing) || (canEdit && !!p.organizationId && canManageAssignment) ? (
          <section className="mt-4 space-y-3 rounded-lg border bg-muted/20 p-3 sm:p-4" aria-label="Team sharing and assignment">
            <div><h3 className="text-sm font-semibold">Team sharing</h3><p className="mt-1 text-xs text-muted-foreground">Private by default. Sharing makes this prospect, its notes, contact details, and attached audit findings visible to current members of the selected team.</p></div>
            {p.canManageSharing ? <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="min-w-0 flex-1 text-sm"><span className="font-medium">Share with</span><Select className="mt-1" value={shareTarget} disabled={saving !== null} onChange={(e) => setShareTarget(e.target.value)}><option value="">Private — only you</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}{p.organizationId && !team ? <option value={p.organizationId}>{p.organizationName || "Current team"}</option> : null}</Select></label>
              <Button size="sm" variant={shareTarget ? "outline" : "ghost"} disabled={saving !== null || shareTarget === (p.organizationId ?? "")} onClick={() => { if (shareTarget) setShareConfirm(shareTarget); else void patch({ organizationId: null, assignedToUserId: null }, "sharing"); }}>{saving === "sharing" ? <Spinner /> : null}{shareTarget ? "Share with team" : "Make private"}</Button>
            </div> : <p className="text-sm text-muted-foreground">Shared with {p.organizationName || team?.name || "a team"}.</p>}
            {p.organizationId && canManageAssignment ? <label className="block text-sm"><span className="font-medium">Assign to</span><Select className="mt-1 sm:max-w-sm" value={p.assignedToUserId ?? ""} disabled={saving !== null || !team} onChange={(e) => void patch({ assignedToUserId: e.target.value || null }, "assignment")}><option value="">Unassigned</option>{team?.members.map((m) => <option key={m.userId} value={m.userId}>{m.displayName || m.email || "Member"}{m.userId === p.assignedToUserId ? " (current)" : ""}</option>)}</Select>{!team ? <span className="mt-1 block text-xs text-muted-foreground">Team membership details are unavailable; refresh the page to retry.</span> : null}</label> : null}
          </section>
        ) : null}

        {open ? (
          <form
            className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await patch({ businessName: form.businessName.trim() || null, location: form.location.trim() || null, notes: form.notes.trim() || null, contactName: form.contactName.trim() || null, contactEmail: form.contactEmail.trim() || null, contactUrl: form.contactUrl.trim() || null }, "details");
              if (ok) setOpen(false);
            }}
          >
            <label className="text-sm"><span className="font-medium">Business name</span><Input value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} maxLength={160} className="mt-1" /></label>
            <label className="text-sm"><span className="font-medium">Location</span><Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} maxLength={160} className="mt-1" /></label>
            <label className="text-sm sm:col-span-3">
              <span className="font-medium">Notes</span>
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={4000} rows={4} className="mt-1 w-full rounded-md border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </label>
            <label className="text-sm"><span className="font-medium">Contact name</span><Input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} maxLength={120} className="mt-1" /></label>
            <label className="text-sm"><span className="font-medium">Contact email</span><Input type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} maxLength={254} className="mt-1" /></label>
            <label className="text-sm"><span className="font-medium">Contact page URL</span><Input type="url" value={form.contactUrl} onChange={(e) => setForm({ ...form, contactUrl: e.target.value })} maxLength={2048} placeholder="https://" className="mt-1" /></label>
            <p className="text-xs text-muted-foreground sm:col-span-3">Only add contact details you obtain from public enquiry channels. These stay private unless you explicitly share this prospect with a team.</p>
            <div className="flex gap-2 sm:col-span-3">
              <Button type="submit" size="sm" disabled={saving !== null}>{saving === "details" ? <Spinner /> : null}Save</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => { setOpen(false); setForm({ businessName: p.businessName ?? "", location: p.location ?? "", notes: p.notes ?? "", contactName: p.contactName ?? "", contactEmail: p.contactEmail ?? "", contactUrl: p.contactUrl ?? "" }); }}>Cancel</Button>
            </div>
          </form>
        ) : null}

        {error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null}
        <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
          {canEdit && !open ? <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Edit notes &amp; contact</Button> : null}
          {p.canDelete ? <Button size="sm" variant="ghost" className="text-danger" onClick={onDelete}>Delete</Button> : null}
        </div>
      </Card>
      <ConfirmDialog open={!!shareConfirm} title={`Share ${p.businessName || p.hostname} with a team?`} confirmLabel="Share prospect" busy={saving === "sharing"} onClose={() => setShareConfirm(null)} onConfirm={async () => {
        if (!shareConfirm) return;
        const target = shareConfirm;
        if (await patch({ organizationId: target, assignedToUserId: null }, "sharing")) setShareConfirm(null);
      }}>
        <p>Current members of <strong>{teams.find((t) => t.id === shareConfirm)?.name || p.organizationName || "the selected team"}</strong> will be able to view this prospect, including its notes, manually entered contact details, and attached audit findings. You can make it private later.</p>
      </ConfirmDialog>
    </li>
  );
}
