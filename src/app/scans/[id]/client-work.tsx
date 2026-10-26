"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { SeverityBadge } from "@/components/badges";
import { Alert, Button, Card, CardHeader, Input, Select, Spinner, cn } from "@/components/ui";
import type { Severity } from "@/lib/audit/types";
import type { MatchedProfessionalService, PublishedPortfolioItem } from "@/lib/professional/types";
import { api, ApiClientError } from "@/lib/client/api";
import { displayUrl, formatDate } from "@/lib/client/format";

interface TalkingPoint {
  findingId: string;
  title: string;
  categoryLabel: string;
  severity: Severity;
  affectedCount: number;
  evidence: string;
  exampleUrls: string[];
  impact: string;
  recommendation: string;
  opportunity: number;
}
export interface OpportunityResponse {
  brief: { headline: string; talkingPoints: TalkingPoint[]; strengths: Array<{ label: string; score: number }>; lowIssueSite: boolean; caveats: string[] };
  ranking: Array<{ findingId: string; opportunity: number }>;
  formula: string;
  prospect: { id: string; status: string; auditId: string | null } | null;
  personalization?: { professional: { professionalName?: string; businessName?: string; jobTitle?: string; headline?: string } | null; matchedServices: MatchedProfessionalService[]; portfolio: PublishedPortfolioItem[] };
}

export type OpportunityState = { kind: "loading" } | { kind: "ok"; data: OpportunityResponse } | { kind: "locked" } | { kind: "error"; message: string };

/** Loads the opportunity brief. A 403 means the feature is disabled on this deployment (shown as a short note, not an error). */
export function useOpportunity(scanId: string, enabled: boolean) {
  const [state, setState] = useState<OpportunityState>({ kind: "loading" });
  const load = useCallback(() => {
    if (!enabled) return;
    setState({ kind: "loading" });
    api<OpportunityResponse>(`/api/scans/${scanId}/opportunity`)
      .then((data) => setState({ kind: "ok", data }))
      .catch((e: ApiClientError) => setState(e.status === 403 ? { kind: "locked" } : { kind: "error", message: e.message }));
  }, [scanId, enabled]);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);
  return { state, reload: load };
}

export function OpportunityPanel({ scanId, state, reload, isOwner }: { scanId: string; state: OpportunityState; reload: () => void; isOwner: boolean }) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  if (state.kind === "loading") return null;
  if (state.kind === "locked") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-5 py-4 text-sm print:hidden">
        <p className="text-secondary"><span className="font-semibold text-foreground">Opportunity brief</span> ranks these findings by impact and turns them into talking points for a client. It is not enabled on this deployment.</p>
      </div>
    );
  }
  if (state.kind === "error") return <Alert tone="warning" className="print:hidden">The opportunity brief couldn&apos;t be loaded: {state.message} <button type="button" className="ml-1 font-semibold underline" onClick={reload}>Retry</button></Alert>;
  const { brief, prospect, formula } = state.data;
  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api("/api/prospects", { method: "POST", json: { auditId: scanId } });
      reload();
    } catch (e) {
      setSaveError((e as ApiClientError).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="print-break">
      <CardHeader
        title="Opportunity brief"
        description={<>Built only from this audit&apos;s verified findings. <span className="font-mono text-[11px] uppercase tracking-wider">No AI</span></>}
        action={
          isOwner ? (
            prospect ? (
              <Link href="/dashboard/prospects" className="text-sm font-semibold text-primary underline underline-offset-4">Saved as prospect ({prospect.status}){prospect.auditId !== scanId ? " · from another audit" : ""}</Link>
            ) : (
              <Button size="sm" onClick={save} disabled={saving}>{saving ? <Spinner /> : null}Save as prospect</Button>
            )
          ) : null
        }
      />
      <div className="space-y-5 p-5">
        {saveError ? <Alert tone="error">{saveError}</Alert> : null}
        {prospect && prospect.auditId !== scanId && isOwner ? (
          <p className="text-xs text-muted-foreground">This site is already a prospect. <button type="button" className="font-semibold underline" onClick={save} disabled={saving}>Update it with this audit</button></p>
        ) : null}
        <p className="font-display text-lg font-medium leading-snug tracking-tight">{brief.headline}</p>
        {state.data.personalization?.matchedServices.length ? (
          <section className="rounded-md border border-primary/20 bg-primary/5 p-4" aria-labelledby="matched-services">
            <h3 id="matched-services" className="text-sm font-semibold">Published services matched to verified findings</h3>
            <p className="mt-1 text-xs text-secondary">Matching is deterministic: selected audit categories and optional keywords are checked against open scanner findings. It does not certify a provider or claim the work is complete.</p>
            <ul className="mt-3 space-y-3">
              {state.data.personalization.matchedServices.map((service) => (
                <li key={service.serviceId} className="border-t pt-3 first:border-0 first:pt-0">
                  <p className="text-sm font-semibold">{service.title}</p>
                  {service.description ? <p className="mt-0.5 text-sm text-secondary">{service.description}</p> : null}
                  <p className="mt-1 text-xs text-muted-foreground">Evidence: {service.matchedFindings.slice(0, 4).map((f) => f.title).join(" · ")}</p>
                </li>
              ))}
            </ul>
            {state.data.personalization.portfolio.length ? <div className="mt-3 border-t pt-3"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Relevant published portfolio</p><ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">{state.data.personalization.portfolio.map((item) => <li key={item.id}><a href={item.projectUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline underline-offset-4">{item.title}</a></li>)}</ul></div> : null}
          </section>
        ) : null}
        {brief.talkingPoints.length ? (
          <ol className="divide-y border-y">
            {brief.talkingPoints.map((t, i) => (
              <li key={t.findingId} className="grid gap-2 py-4 sm:grid-cols-[2rem_1fr]">
                <span className="font-mono text-xs text-primary">{String(i + 1).padStart(2, "0")}</span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={t.severity} />
                    <Link href={`/scans/${scanId}/issues/${t.findingId}`} className="font-semibold hover:text-primary hover:underline">{t.title}</Link>
                    <span className="text-xs text-muted-foreground">{t.categoryLabel} · {t.affectedCount} page{t.affectedCount === 1 ? "" : "s"}</span>
                  </div>
                  <p className="mt-1.5 text-sm text-secondary"><span className="font-medium text-foreground">Evidence:</span> {t.evidence}</p>
                  {t.exampleUrls.length ? <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{t.exampleUrls.map((u) => displayUrl(u, 60)).join("  ·  ")}</p> : null}
                  <p className="mt-1.5 text-sm text-secondary"><span className="font-medium text-foreground">Why it matters:</span> {t.impact}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : <p className="text-sm text-secondary">No actionable issues were found on the pages checked.</p>}
        {brief.strengths.length ? (
          <div>
            <h3 className="text-sm font-semibold">Strengths</h3>
            <p className="mt-1 text-sm text-secondary">{brief.strengths.map((s) => `${s.label} ${s.score}/100`).join(" · ")}</p>
          </div>
        ) : null}
        <ul className="space-y-1 border-l-2 border-gold pl-4 text-xs leading-5 text-secondary">
          {brief.caveats.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <p className="text-xs text-muted-foreground">Ranking: {formula}</p>
      </div>
    </Card>
  );
}

interface Share { id: string; label: string | null; allowPdf: boolean; snapshotVersion?: number | null; createdAt: string; expiresAt: string; revokedAt: string | null; lastViewedAt: string | null; viewCount: number; active: boolean }

/** Owner-only management of expiring, revocable client report links (Business). */
export function ShareLinksPanel({ scanId }: { scanId: string }) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(30);
  const [label, setLabel] = useState("");
  const [allowPdf, setAllowPdf] = useState(true);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => {
    setError(null);
    api<{ shares: Share[]; available: boolean }>(`/api/scans/${scanId}/shares`)
      .then((d) => { setShares(d.shares); setAvailable(d.available); })
      .catch((e: ApiClientError) => setError(e.message));
  }, [scanId]);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);
  if (!shares && !error) return null;
  if (!shares && error) return (
    <Card className="print:hidden">
      <CardHeader title="Client report links" description="Read-only links to this report. Anyone with a link can view it until it expires or you revoke it." />
      <div className="flex flex-wrap items-center gap-3 p-5"><Alert tone="error">{error}</Alert><Button size="sm" variant="outline" onClick={load}>Retry</Button></div>
    </Card>
  );
  if (!available && shares?.length === 0) return null;
  const items = shares ?? [];
  const create = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const r = await api<{ url: string }>(`/api/scans/${scanId}/shares`, { method: "POST", json: { expiresInDays: days, label: label.trim() || null, allowPdf } });
      setCreated(r.url);
      setLabel("");
      load();
    } catch (e) {
      setError((e as ApiClientError).message);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    setBusy(true);
    try {
      await api(`/api/scans/${scanId}/shares/${id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError((e as ApiClientError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="print:hidden">
      <CardHeader title="Client report links" description="Read-only links to this report. Anyone with a link can view it until it expires or you revoke it." />
      <div className="space-y-4 p-5">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {created ? (
          <Alert tone="success" title="Link created. Copy it now: it won't be shown again.">
            <div className="mt-1 flex flex-col gap-2 sm:flex-row">
              <Input readOnly value={created} onFocus={(e) => e.currentTarget.select()} aria-label="New report link" className="font-mono text-xs" />
              <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(created).then(() => setCopied(true))}>{copied ? "Copied" : "Copy"}</Button>
            </div>
          </Alert>
        ) : null}
        {available ? (
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center">
            <Input placeholder="Label (optional, only you see it)" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} aria-label="Link label" />
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Link expires after">
              {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>Expires in {d} days</option>)}
            </Select>
            <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={allowPdf} onChange={(e) => setAllowPdf(e.target.checked)} /> Allow PDF</label>
            <Button size="sm" onClick={create} disabled={busy}>Create link</Button>
          </div>
        ) : <p className="text-sm text-secondary">Creating new links is disabled on this deployment. Existing links keep working until they expire, and you can still revoke them.</p>}
        {items.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr><th className="py-2 font-medium">Link</th><th className="py-2 font-medium">Expires</th><th className="py-2 text-right font-medium">Views</th><th className="py-2" /></tr>
              </thead>
              <tbody className="divide-y">
                {items.map((s) => (
                  <tr key={s.id} className={cn(!s.active && "text-muted-foreground")}>
                    <td className="py-2.5">{s.label || "Untitled link"}{s.allowPdf ? " · PDF" : ""}{s.snapshotVersion ? ` · Snapshot v${s.snapshotVersion}` : " · Legacy live view"}<span className="block text-xs text-muted-foreground">Created {formatDate(s.createdAt)}</span></td>
                    <td className="py-2.5">{s.revokedAt ? "Revoked" : s.active ? formatDate(s.expiresAt) : "Expired"}</td>
                    <td className="py-2.5 text-right tabular-nums">{s.viewCount}</td>
                    <td className="py-2.5 text-right">{s.active ? <Button size="sm" variant="ghost" onClick={() => void revoke(s.id)} disabled={busy}>Revoke</Button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
