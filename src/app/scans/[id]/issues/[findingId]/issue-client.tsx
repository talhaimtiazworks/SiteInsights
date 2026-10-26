"use client";

import { ScanAccessError } from "@/components/scan-access-error";
import { IssueSkeleton } from "@/components/skeletons";
import Link from "next/link";
import { useEffect, useState } from "react";
import { SeverityBadge, TypeBadge } from "@/components/badges";
import { Alert, Badge, Button, ButtonLink, Card, CardHeader, Spinner } from "@/components/ui";
import { CATEGORY_LABELS, SEVERITY_LABELS } from "@/lib/audit/types";
import { aiCredentials, useAiSession } from "@/lib/client/ai-session";
import { api, ApiClientError } from "@/lib/client/api";
import { displayUrl, formatDateTime, formatDuration } from "@/lib/client/format";
import type { AiRecord, Finding, IssueExplanation, PageSummary, ProvidersResponse, PublicScan } from "@/lib/client/types";

interface IssueResponse {
  scan: PublicScan;
  finding: Finding;
  page: PageSummary | null;
  ai: AiRecord<IssueExplanation> | null;
}

const PROVIDER_LABEL = { openrouter: "OpenRouter", gemini: "Google Gemini" } as const;

export function IssueClient({ scanId, findingId }: { scanId: string; findingId: string }) {
  const [data, setData] = useState<IssueResponse | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    api<IssueResponse>(`/api/scans/${scanId}/findings/${findingId}`).then(setData).catch(setError);
  }, [scanId, findingId]);

  if (error) {
    if (error.code === "finding_not_found") {
      return (
        <div className="container max-w-2xl py-16">
          <Alert tone="error" title="Issue not found">This issue isn&apos;t part of the audit. The link may be outdated.</Alert>
          <div className="mt-6 flex gap-3"><ButtonLink href={`/scans/${scanId}`}>Back to report</ButtonLink><ButtonLink href="/dashboard" variant="outline">Dashboard</ButtonLink></div>
        </div>
      );
    }
    return <ScanAccessError error={error} what="report" />;
  }
  if (!data) return <IssueSkeleton />;

  const { finding: f, page } = data;
  const urls = showAll ? f.affectedUrls : f.affectedUrls.slice(0, 10);

  return (
    <div className="container max-w-4xl space-y-6 py-10">
      <p className="text-sm text-muted-foreground print:hidden">
        <Link href="/dashboard" className="hover:underline">Dashboard</Link> / <Link href={`/scans/${scanId}`} className="hover:underline">{displayUrl(data.scan.targetUrl, 40)}</Link> / Issue
      </p>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={f.severity} />
          <TypeBadge type={f.type} />
          <Badge className="border-border text-muted-foreground">{CATEGORY_LABELS[f.category]}</Badge>
          <Badge className="border-border font-mono text-muted-foreground">{f.ruleId}</Badge>
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{f.title}</h1>
        <p className="mt-2 leading-7 text-muted-foreground">{f.description}</p>
      </div>

      <Card>
        <CardHeader title="Evidence" description={`Detected ${formatDateTime(f.createdAt)} · ${f.affectedCount} affected URL${f.affectedCount === 1 ? "" : "s"}`} />
        <div className="space-y-4 p-5 text-sm">
          <p className="font-medium">{f.evidence.summary}</p>
          {f.evidence.items.length ? (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <tbody className="divide-y">
                  {f.evidence.items.map((i, idx) => (
                    <tr key={`${i.label}-${idx}`} className="align-top">
                      <th scope="row" className="w-2/5 break-all px-3 py-2 text-left font-mono text-xs font-normal text-muted-foreground">{i.label}</th>
                      <td className="break-words px-3 py-2">{i.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {f.evidence.urls.length ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Found on</p>
              <ul className="mt-1 space-y-0.5">{f.evidence.urls.map((u) => <li key={u}><a href={u} target="_blank" rel="noopener noreferrer nofollow" className="break-all font-mono text-xs hover:underline">{u}</a></li>)}</ul>
            </div>
          ) : null}
          <div className="rounded-lg bg-muted/50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">How this was detected</p>
            <p className="mt-1">{f.detectionMethod}</p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Recommended action" description="Standard guidance for this check from the SiteInsights rule catalogue — not AI-generated." />
        <p className="p-5 text-sm leading-7">{f.recommendation}</p>
      </Card>

      <AiPanel scanId={scanId} finding={f} initial={data.ai} />

      <Card>
        <CardHeader title="Affected URLs" description={`${f.affectedCount} URL${f.affectedCount === 1 ? "" : "s"}`} />
        <ul className="divide-y">
          {urls.map((u) => <li key={u} className="px-5 py-2"><a href={u} target="_blank" rel="noopener noreferrer nofollow" className="break-all font-mono text-xs hover:underline">{u}</a></li>)}
        </ul>
        {f.affectedUrls.length > 10 ? <div className="border-t p-3"><Button size="sm" variant="ghost" onClick={() => setShowAll((s) => !s)}>{showAll ? "Show fewer" : `Show all ${f.affectedUrls.length}`}</Button></div> : null}
      </Card>

      {page ? (
        <Card>
          <CardHeader title="Recorded page data" description={displayUrl(page.finalUrl, 80)} />
          <dl className="grid gap-x-6 gap-y-3 p-5 text-sm sm:grid-cols-2">
            {[
              ["HTTP status", page.fetchError ? `${page.fetchError.code} — ${page.fetchError.message}` : String(page.statusCode ?? "—")],
              ["Response time", formatDuration(page.responseTimeMs)],
              ["Content type", page.contentType ?? "—"],
              ["Fetched", formatDateTime(page.fetchedAt)],
              ["Title", page.title ?? "(none)"],
              ["Meta description", page.metaDescription ?? "(none)"],
              ["H1", page.h1.length ? page.h1.join(" | ") : "(none)"],
              ["Canonical", page.canonical ?? "(none)"],
              ["Robots meta / X-Robots-Tag", [page.robotsMeta, page.xRobotsTag].filter(Boolean).join(" · ") || "(none)"],
              ["Links (internal / external)", `${page.internalLinkCount} / ${page.externalLinkCount}`],
              ["Images (missing alt)", `${page.imageCount} (${page.imagesMissingAlt})`],
              ["Redirects", page.redirectChain.length ? page.redirectChain.map((h) => `${h.status}`).join(" → ") + ` → ${page.finalUrl}` : "none"],
            ].map(([k, v]) => (
              <div key={k}><dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{k}</dt><dd className="mt-0.5 break-words">{v}</dd></div>
            ))}
          </dl>
        </Card>
      ) : null}

      <div className="print:hidden"><ButtonLink href={`/scans/${scanId}`} variant="outline">← Back to report</ButtonLink></div>
    </div>
  );
}

function AiPanel({ scanId, finding, initial }: { scanId: string; finding: Finding; initial: AiRecord<IssueExplanation> | null }) {
  const [rec, setRec] = useState(initial);
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useAiSession();

  useEffect(() => {
    api<ProvidersResponse>("/api/ai/providers").then(setProviders).catch(() => setProviders(null));
  }, []);

  async function run(regenerate: boolean) {
    const creds = aiCredentials();
    if (!creds) {
      setError("No AI key in memory. Connect your own provider key on the AI settings page first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ ai: AiRecord<IssueExplanation> }>(`/api/scans/${scanId}/findings/${finding.id}/ai`, { method: "POST", json: { provider: creds.provider, apiKey: creds.apiKey, regenerate } });
      setRec(r.ai);
    } catch (e) {
      const err = e as ApiClientError;
      const reset = typeof err.details?.resetAt === "string" ? ` Resets around ${formatDateTime(err.details.resetAt)}.` : "";
      setError(`${err.message}${reset}`);
    } finally {
      setBusy(false);
    }
  }

  const label = session ? providers?.providers.find((p) => p.id === session.provider)?.label ?? session.provider : null;
  const c = rec?.content;
  return (
    <Card className="print-break">
      <CardHeader
        title={<span className="flex items-center gap-2">AI explanation {rec ? <Badge className="border-primary/30 bg-primary/10 text-primary">AI-generated</Badge> : null}</span>}
        description="Based only on the evidence above, using your own provider key. AI can be wrong — verify before making changes."
      />
      <div className="p-5">
        {!session ? (
          <p className="text-sm text-muted-foreground">
            Bring Your Own Key: connect your own OpenRouter or Gemini key (kept in this session’s memory only) to get an AI explanation of this finding.
            The evidence and recommendation above are complete without AI. <Link href="/settings/ai" className="text-primary hover:underline">AI settings</Link>
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 print:hidden">
              <span className="text-sm text-muted-foreground">Using your <strong className="text-foreground">{label}</strong> key</span>
              <Button onClick={() => run(!!rec)} disabled={busy} size="sm" variant={rec ? "outline" : "primary"}>
                {busy ? <Spinner /> : null}{busy ? "Generating…" : rec ? "Regenerate" : "Explain with AI"}
              </Button>
              <span className="text-xs text-muted-foreground">{rec ? "Regenerating" : "This"} sends the finding’s evidence to {label} on your account.</span>
            </div>
            {error ? <Alert tone="error" className="mt-4">{error}</Alert> : null}
            {c ? (
              <div className="mt-5 space-y-5 text-sm">
                <Section title="What this means"><p className="leading-7">{c.plainLanguage}</p></Section>
                <Section title="Potential impact"><p className="leading-7">{c.impact}</p></Section>
                <Section title="How to fix it">
                  <p className="leading-7">{c.recommendation}</p>
                  {c.steps.length ? <ol className="mt-2 list-decimal space-y-1 pl-5">{c.steps.map((s, i) => <li key={i}>{s}</li>)}</ol> : null}
                </Section>
                {c.exampleCode ? (
                  <Section title={`Example (${c.exampleCode.language})`}>
                    {c.exampleCode.description ? <p className="mb-2 text-muted-foreground">{c.exampleCode.description}</p> : null}
                    <pre className="overflow-x-auto rounded-lg bg-navy p-4 text-xs leading-5 text-on-dark"><code>{c.exampleCode.code}</code></pre>
                  </Section>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Badge className="border-border bg-muted text-muted-foreground">Priority: {c.priority}</Badge>
                  <Badge className="border-border bg-muted text-muted-foreground">Effort: {c.effort}</Badge>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-success">Confirmed by evidence</p>
                    {c.confirmedFacts.length ? <ul className="mt-1 list-disc space-y-1 pl-4">{c.confirmedFacts.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="mt-1 text-muted-foreground">—</p>}
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-warning">Hypotheses (not verified)</p>
                    {c.hypotheses.length ? <ul className="mt-1 list-disc space-y-1 pl-4">{c.hypotheses.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="mt-1 text-muted-foreground">—</p>}
                  </div>
                </div>
                {c.limitations ? <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground"><span className="font-semibold">Limitations: </span>{c.limitations}</p> : null}
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Severity review</p>
                  {c.severityAssessment.suggestedSeverity ? (
                    <p className="mt-1">AI suggests <strong>{SEVERITY_LABELS[c.severityAssessment.suggestedSeverity]}</strong> instead of the scanner&apos;s <strong>{SEVERITY_LABELS[finding.severity]}</strong>. {c.severityAssessment.reasoning} <span className="text-muted-foreground">(Suggestion only — the recorded severity is unchanged.)</span></p>
                  ) : (
                    <p className="mt-1">Agrees with the scanner&apos;s severity ({SEVERITY_LABELS[finding.severity]}). {c.severityAssessment.reasoning}</p>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Generated by {PROVIDER_LABEL[rec!.provider]} ({rec!.model}) on {formatDateTime(rec!.createdAt)}.
                  {rec!.fallbackFrom ? ` Fallback used because ${PROVIDER_LABEL[rec!.fallbackFrom]} failed: ${c.fallbackReason ?? "error"}.` : ""} No changes were made to your website.
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-semibold">{title}</p>
      <div className="mt-1 text-foreground/90">{children}</div>
    </div>
  );
}
