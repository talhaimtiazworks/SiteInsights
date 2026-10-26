"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { InlineError } from "@/components/load-error";
import { SettingsSkeleton } from "@/components/skeletons";
import { Alert, Badge, Card, CardHeader, PageHeader, ProgressBar } from "@/components/ui";
import { api } from "@/lib/client/api";
import { formatDateTime } from "@/lib/client/format";
import type { UsageDecision, UsageResponse } from "@/lib/client/types";

function windowLabel(seconds: number) {
  if (seconds % 86400 === 0) return seconds === 86400 ? "24 hours" : `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? "hour" : `${seconds / 3600} hours`;
  return `${Math.round(seconds / 60)} minutes`;
}

function Meter({ title, d, unit, unavailable }: { title: string; d: UsageDecision; unit: string; unavailable?: boolean }) {
  return (
    <Card className="p-5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-medium">{title}{unavailable ? <Badge className="ml-2 border-border align-middle text-muted-foreground">Not available on this server</Badge> : null}</p>
        <p className="text-sm tabular-nums text-muted-foreground">{d.used} / {d.limit} used</p>
      </div>
      <ProgressBar className="mt-3" value={d.limit > 0 ? (100 * d.used) / d.limit : 100} label={`${title} used`} />
      <p className="mt-3 text-sm">
        <span className="font-semibold tabular-nums">{d.remaining}</span> {unit} remaining in the rolling {windowLabel(d.windowSeconds)} window.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {d.resetAt ? `${d.remaining === 0 ? "Next" : "Oldest"} allowance returns ${formatDateTime(d.resetAt)}.` : "Nothing used in the current window."}
        {d.limitedBy === "ip" ? " Shared network limit applies." : ""}
      </p>
    </Card>
  );
}

export function UsageClient({ embedded = false }: { embedded?: boolean } = {}) {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setBusy(true);
    api<UsageResponse>("/api/usage")
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch(setError)
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const e = data?.entitlements;
  return (
    <div className={embedded ? "space-y-6" : "container max-w-3xl space-y-6 py-10"}>
      <PageHeader title={embedded ? "Usage" : "Usage & limits"} description="Everything in SiteInsights is free. These windows are technical anti-abuse safeguards, not paid tiers." />
      {error ? <Card><InlineError error={error} what="your usage" onRetry={load} busy={busy} /></Card> : null}
      {!data && !error ? <SettingsSkeleton label="Loading usage" /> : null}
      {data && e ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Meter title="Scans" d={data.usage.scans} unit="scans" />
            <Meter title="AI requests" d={data.usage.ai} unit="AI requests" />
            {data.usage.browserPages ? <Meter title="Browser-rendered pages" d={data.usage.browserPages} unit="pages" unavailable={data.available && !data.available.browserRendering} /> : null}
            {data.usage.accessibility ? <Meter title="Accessibility tests" d={data.usage.accessibility} unit="page tests" unavailable={data.available && !data.available.accessibility} /> : null}
            {data.usage.performance ? <Meter title="Performance tests" d={data.usage.performance} unit="tests" unavailable={data.available && !data.available.performance} /> : null}
            {data.usage.pdf ? <Meter title="PDF exports" d={data.usage.pdf} unit="exports" /> : null}
          </div>
          <Card>
            <CardHeader title="Usage windows and technical limits" description={data.account?.signedIn ? "These are enforced on the server for your account (and, to stop abuse, per network) — none of them involves payment." : "These are enforced on the server for each browser and network — none of them involves payment."} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody className="divide-y">
                  {[
                    ["Pages per scan", `${e.maxPagesPerScan}`],
                    ["Crawl depth", `${e.maxDepth} clicks from the start page`],
                    ["Link destinations checked per scan", `${e.maxLinksToCheck}`],
                    ["Scans", `${e.scansPerWindow} per ${windowLabel(e.scanWindowSeconds)}`],
                    ["AI explanations & summaries", `${e.aiRequestsPerWindow} per ${windowLabel(e.aiWindowSeconds)}`],
                    ["AI input size", `${e.maxAiInputChars.toLocaleString()} characters per request`],
                    ["Browser-rendered pages", `Up to ${e.maxBrowserPagesPerScan} per scan, ${e.browserPagesPerWindow} per ${windowLabel(e.advancedWindowSeconds)}`],
                    ["Accessibility tests (axe-core)", `${e.accessibilityTestsPerWindow} pages per ${windowLabel(e.advancedWindowSeconds)}`],
                    ["Performance tests", `${e.performanceTestsPerWindow} per ${windowLabel(e.advancedWindowSeconds)} (mobile and desktop count separately)`],
                    ["PDF exports", `${e.pdfExportsPerWindow} per ${windowLabel(e.advancedWindowSeconds)}`],
                    ["Concurrent scans", `${e.maxConcurrentScans} (currently running: ${data.activeScans})`],
                    ["Scan history kept", `Your ${e.historyLimit} most recent scans`],
                  ].map(([k, v]) => (
                    <tr key={k}><th scope="row" className="w-1/2 px-5 py-3 text-left font-normal text-muted-foreground">{k}</th><td className="px-5 py-3 font-medium">{v}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          {!data.storage.persistent ? <Alert tone="warning">This deployment runs without a database, so usage counters and scan history are held in memory and reset when the server restarts.</Alert> : null}
          <Card className="p-5 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Everything is free</p>
            <p className="mt-2">
              SiteInsights is free for everyone — there are no subscriptions, credits or paid plans. The windows above are technical safeguards that keep the service fast and fair; none of them can be bought, raised or upgraded.{" "}
              {data.account?.signedIn
                ? "Your usage is counted for your account, so it follows you across devices."
                : data.account?.accountsEnabled
                  ? "A verified account is required for every audit. Sign in to view your account usage; network limits also help protect the service."
                  : "Usage is tracked anonymously with a first-party cookie and a hashed network identifier so that limits are fair for everyone."}{" "}
              Operations that could not run (failed AI requests, browser renders, performance tests or PDF exports) do not consume your allowance.
            </p>
            <p className="mt-2">Questions? <Link href="/contact" className="text-primary hover:underline">Contact us</Link>.</p>
          </Card>
        </>
      ) : null}
    </div>
  );
}
