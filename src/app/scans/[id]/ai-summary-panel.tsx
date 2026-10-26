"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, Badge, Button, Card, CardHeader, Spinner } from "@/components/ui";
import { aiCredentials, useAiSession } from "@/lib/client/ai-session";
import { api, ApiClientError } from "@/lib/client/api";
import { formatDateTime } from "@/lib/client/format";
import type { ClientFinding, ResultsResponse } from "@/lib/client/types";

const PROVIDER_LABEL = { openrouter: "OpenRouter", gemini: "Google Gemini" } as const;

export function AiSummaryPanel({ scanId, initial, findings }: { scanId: string; initial: ResultsResponse["aiSummary"]; findings: ClientFinding[] }) {
  const [rec, setRec] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useAiSession();
  const byId = new Map(findings.map((f) => [f.id, f]));

  async function generate(regenerate = false) {
    const creds = aiCredentials();
    if (!creds) {
      setError("No AI key in memory. Connect your own provider key on the AI settings page first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ ai: NonNullable<ResultsResponse["aiSummary"]> }>(`/api/scans/${scanId}/ai-summary`, { method: "POST", json: { provider: creds.provider, apiKey: creds.apiKey, regenerate } });
      setRec(r.ai);
    } catch (e) {
      const err = e as ApiClientError;
      const reset = typeof err.details?.resetAt === "string" ? ` Resets around ${formatDateTime(err.details.resetAt)}.` : "";
      setError(err.message + reset);
    } finally {
      setBusy(false);
    }
  }

  const c = rec?.content;
  return (
    <Card className="print-break">
      <CardHeader
        title={<span className="flex items-center gap-2">AI audit summary {rec ? <Badge className="border-primary/30 bg-primary/10 text-primary">AI-generated</Badge> : null}</span>}
        description={rec ? "Written from the verified findings below. Review before acting." : "An optional overview written from the verified findings below."}
        action={
          rec && session ? (
            <Button size="sm" variant="ghost" className="print:hidden" onClick={() => generate(true)} disabled={busy} title="Regenerates using your key">
              {busy ? <Spinner /> : null}Regenerate
            </Button>
          ) : null
        }
      />
      <div className="p-5">
        {error ? <Alert tone="error" className="mb-4">{error}</Alert> : null}
        {!c ? (
          session ? (
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">Get a plain-language overview and a prioritised fix list, generated with your own {session.provider === "openrouter" ? "OpenRouter" : "Google Gemini"} key (billed by your provider account).</p>
              <Button onClick={() => generate(false)} disabled={busy} className="print:hidden">{busy ? <Spinner /> : null}{busy ? "Generating…" : "Generate AI summary"}</Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Bring Your Own Key: connect your own provider key to get an AI summary of these verified findings. All findings below are complete without AI. <Link href="/settings/ai" className="text-primary hover:underline">AI settings</Link></p>
          )
        ) : (
          <div className="space-y-5 text-sm">
            <p className="leading-7">{c.overview}</p>
            {c.keyRisks.length ? (
              <div>
                <p className="font-semibold">Key risks</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">{c.keyRisks.map((r) => <li key={r}>{r}</li>)}</ul>
              </div>
            ) : null}
            {c.priorities.length ? (
              <div>
                <p className="font-semibold">Suggested order of fixes</p>
                <ol className="mt-2 space-y-3">
                  {c.priorities.map((p, i) => (
                    <li key={`${p.title}-${i}`} className="rounded-lg border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">{i + 1}</span>
                        <span className="font-medium">{p.title}</span>
                        <Badge className="border-border bg-muted text-muted-foreground">Impact: {p.impact}</Badge>
                        <Badge className="border-border bg-muted text-muted-foreground">Effort: {p.effort}</Badge>
                      </div>
                      <p className="mt-1.5 text-muted-foreground">{p.reason}</p>
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                        {p.findingIds.map((fid) => byId.get(fid) ? <Link key={fid} href={`/scans/${scanId}/issues/${fid}`} className="text-xs font-medium text-primary hover:underline">{byId.get(fid)!.title}</Link> : null)}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            {c.quickWins.length ? (
              <div>
                <p className="font-semibold">Quick wins</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">{c.quickWins.map((r) => <li key={r}>{r}</li>)}</ul>
              </div>
            ) : null}
            {c.limitations ? <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground"><span className="font-semibold">Limitations: </span>{c.limitations}</p> : null}
            <p className="text-xs text-muted-foreground">
              Generated with your own key by {PROVIDER_LABEL[rec.provider]} ({rec.model}) on {formatDateTime(rec.createdAt)}
              {c.omittedFindings ? ` · ${c.omittedFindings} lower-priority finding(s) were not sent to the AI due to input limits` : ""}
              {c.droppedUnsupported ? ` · ${c.droppedUnsupported} unsupported item(s) referencing unknown findings were removed` : ""}.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
