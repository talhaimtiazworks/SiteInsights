"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { InlineError } from "@/components/load-error";

import { SettingsSkeleton, TableSkeleton } from "@/components/skeletons";
import { Alert, Badge, Card, CardHeader, PageHeader, ProgressBar, cn } from "@/components/ui";
import { api } from "@/lib/client/api";
import { formatDate, formatDateTime, formatNumber } from "@/lib/client/format";
import type { BillingResponse, LedgerItem } from "@/lib/client/types";
import { useCredits } from "@/lib/client/use-credits";

const PAGE_SIZE = 50;

/** Plain-language description of one ledger entry, derived only from what the server recorded. */
function describeEntry(e: LedgerItem): { title: string; note?: string } {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : null);
  switch (e.operation) {
    case "monthly_grant":
      return { title: "Monthly credit allowance" };
    case "period_end":
      return { title: "Unused credits expired", note: "Allowances do not roll over to the next billing period." };
    case "audit":
      return { title: "Audit reserved", note: n("maxPages") !== null ? `Held for up to ${n("maxPages")} pages; unused credits come back when the audit ends.` : undefined };
    case "audit_settlement": {
      const policy = String(d.policy ?? "");
      const pages = n("pagesProcessed");
      const charged = n("charged");
      if (policy.endsWith("_refunded")) {
        const why = policy === "failed_refunded" ? "the audit failed" : policy === "stalled_refunded" ? "the audit stopped responding" : "the audit was deleted before it finished";
        return { title: "Audit refunded", note: `Full refund because ${why}.` };
      }
      return { title: policy === "cancelled" ? "Cancelled audit settled" : "Audit settled", note: charged !== null && pages !== null ? `Charged ${charged} credits for ${pages} processed page${pages === 1 ? "" : "s"}; the rest of the reservation was returned.` : undefined };
    }
    case "ai_explanation":
      return { title: "AI explanation" };
    case "ai_summary":
      return { title: "AI summary" };
    case "pdf_export":
      return { title: "PDF report" };
    default:
      if (e.operation.endsWith("_refund")) return { title: "Refund", note: "The operation failed, so its credits were returned." };
      if (e.type === "adjust") return { title: "Manual adjustment" };
      return { title: e.operation.replace(/_/g, " ") };
  }
}

function subscriptionLine(b: BillingResponse) {
  const s = b.subscription;
  if (!s) return b.plan.id === "free" ? "Free plan. No subscription, nothing is billed." : null;
  const status = s.status.replace(/_/g, " ");
  if (s.cancelAtPeriodEnd && s.currentPeriodEnd) return `Cancelled: ${b.plan.name} stays active until ${formatDate(s.currentPeriodEnd)}, then the account moves to Free.`;
  if (s.status === "past_due") return `Payment failed. ${b.plan.name} stays active until ${s.currentPeriodEnd ? formatDate(s.currentPeriodEnd) : "the end of the period"}, but no new allowance is granted until payment succeeds.`;
  return `Subscription ${status}${s.currentPeriodEnd ? `, renews ${formatDate(s.currentPeriodEnd)}` : ""}.`;
}

export function BillingClient() {
  const params = useSearchParams();
  const returned = params.get("checkout") === "returned";
  const [billing, setBilling] = useState<BillingResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const credits = useCredits(true, PAGE_SIZE);

  const load = useCallback(() => {
    setBusy(true);
    api<BillingResponse>("/api/billing")
      .then((d) => {
        setBilling(d);
        setError(null);
      })
      .catch(setError)
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const s = billing?.credits;
  const ledger = credits.data?.ledger;

  return (
    <div className="container max-w-4xl space-y-6 py-10">
      <PageHeader title="Account & history" description="SiteInsights is free for everyone. Below are your preserved historical plan, credit and payment records — kept for reference only. Nothing here can change what you can do; every feature is already included." />

      {returned ? (
        <Alert tone="info" title="Checkout finished">
          Your plan changes only after the payment provider confirms the payment to our server. That usually takes a few seconds; refresh this page if it still shows your old plan.
        </Alert>
      ) : null}

      {error ? <Card><InlineError error={error} what="your billing details" onRetry={load} busy={busy} /></Card> : null}
      {!billing && !error ? <SettingsSkeleton label="Loading plan" /> : null}

      {billing && s ? (
        <>
          <div className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
            <Card className="p-5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Credits this period</p>
              <p className="mt-2 font-display text-4xl font-semibold tabular-nums">
                {formatNumber(s.balance)} <span className="text-base font-normal text-muted-foreground">of {formatNumber(s.allowance)} available</span>
              </p>
              <ProgressBar className="mt-4" value={s.allowance > 0 ? (100 * s.balance) / s.allowance : 0} label="Credits available" />
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-muted-foreground">Used</dt><dd className="font-medium tabular-nums">{formatNumber(s.used)}</dd></div>
                <div><dt className="text-muted-foreground">Resets</dt><dd className="font-medium">{formatDate(s.resetsAt)}</dd></div>
                <div><dt className="text-muted-foreground">Full {s.plan.maxPagesPerAudit}-page audit</dt><dd className="font-medium tabular-nums">up to {formatNumber(s.fullAuditCost)} credits</dd></div>
                <div><dt className="text-muted-foreground">Largest audit you can start now</dt><dd className="font-medium tabular-nums">{s.affordablePages > 0 ? `${formatNumber(s.affordablePages)} pages` : "None"}</dd></div>
              </dl>
              {s.low ? (
                <Alert tone="warning" className="mt-4" title={s.affordablePages > 0 ? "Credits are running low" : "Not enough credits to start an audit"}>
                  {s.affordablePages > 0 ? `You can still audit up to ${s.affordablePages} pages.` : `An audit needs at least ${s.costs.auditStart + s.costs.perPage} credits.`} Your allowance resets on {formatDate(s.resetsAt)}.
                </Alert>
              ) : null}
            </Card>

            <Card className="flex flex-col p-5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Current plan</p>
              <p className="mt-2 font-display text-3xl font-semibold">{billing.plan.name}</p>
              <p className="text-sm text-muted-foreground tabular-nums">{`$${billing.plan.priceUsd} / month`}</p>
              <p className="mt-3 text-sm">{subscriptionLine(billing)}</p>
              <div className="mt-auto space-y-2 pt-5">
                <Alert tone="info" className="mt-4" title="SiteInsights is free for everyone">
                  Every feature — audits, AI assistance, PDF reports, prospects, batches and share links — is available without subscriptions or credits. Historical plan, payment and subscription records below are preserved for reference only.
                </Alert>
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader title="What costs credits" description="The cost of an audit is shown before it starts. Credits are reserved for the maximum page count and the unused part comes back when the audit ends." />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody className="divide-y">
                  {[
                    ["Starting an audit", s.costs.auditStart],
                    ["Each page successfully processed", s.costs.perPage],
                    ["AI explanation or summary", s.costs.aiRequest],
                    ["PDF report", s.costs.pdfExport],
                  ].map(([k, v]) => (
                    <tr key={k as string}><th scope="row" className="px-5 py-3 text-left font-normal text-muted-foreground">{k}</th><td className="px-5 py-3 text-right font-medium tabular-nums">{v === 0 ? "Free" : `${v} credit${v === 1 ? "" : "s"}`}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t px-5 py-3 text-xs text-muted-foreground">Failed audits are refunded in full. Cancelled audits are charged only for pages already processed. A failed AI request or PDF build is refunded automatically.</p>
          </Card>
        </>
      ) : null}

      <Card>
        <CardHeader title="Credit history" description={ledger ? `${formatNumber(ledger.total)} entr${ledger.total === 1 ? "y" : "ies"}${ledger.total > PAGE_SIZE ? `, latest ${PAGE_SIZE} shown` : ""}.` : "Every grant, reservation, charge and refund."} />
        {credits.error ? <InlineError error={credits.error} what="your transaction history" onRetry={credits.reload} busy={credits.loading} /> : null}
        {!ledger && !credits.error ? <TableSkeleton rows={5} className="m-5" /> : null}
        {ledger && ledger.items.length === 0 ? <p className="px-5 pb-5 text-sm text-muted-foreground">No credit activity yet. Your first audit will appear here.</p> : null}
        {ledger && ledger.items.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="border-y bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr><th className="px-5 py-2 font-medium">Date</th><th className="px-5 py-2 font-medium">Activity</th><th className="px-5 py-2 text-right font-medium">Change</th><th className="px-5 py-2 text-right font-medium">Balance</th></tr>
              </thead>
              <tbody className="divide-y">
                {ledger.items.map((e) => {
                  const d = describeEntry(e);
                  return (
                    <tr key={e.id} className="align-top">
                      <td className="whitespace-nowrap px-5 py-3 text-muted-foreground">{formatDateTime(e.createdAt)}</td>
                      <td className="px-5 py-3">
                        <span className="font-medium">{d.title}</span>
                        {e.auditId ? <> · <Link href={`/scans/${e.auditId}`} className="text-primary hover:underline">audit</Link></> : null}
                        {d.note ? <p className="mt-0.5 text-xs text-muted-foreground">{d.note}</p> : null}
                      </td>
                      <td className={cn("whitespace-nowrap px-5 py-3 text-right font-medium tabular-nums", e.delta > 0 ? "text-success" : e.delta < 0 ? "text-foreground" : "text-muted-foreground")}>{e.delta > 0 ? `+${formatNumber(e.delta)}` : formatNumber(e.delta)}</td>
                      <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums text-muted-foreground">{formatNumber(e.balanceAfter)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      {billing?.subscription ? <p className="text-xs text-muted-foreground">Billing provider: <Badge className="border-border">{billing.subscription.provider}</Badge></p> : null}
    </div>
  );
}
