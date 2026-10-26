import type { Metadata } from "next";
import Link from "next/link";
import { SystemNotice } from "@/components/system-notice";
import { Card, PageHeader } from "@/components/ui";
import { UrlForm } from "@/components/url-form";
import { getConfig } from "@/lib/config/env";
import { availableChecks } from "@/lib/services/scans";

export const metadata: Metadata = { title: "New audit" };
// Rendered per request so limits and optional checks reflect the running configuration.
export const dynamic = "force-dynamic";

export default function NewAuditPage() {
  const cfg = getConfig();
  const s = cfg.scanner;
  const checks = availableChecks();
  return (
    <div className="container max-w-3xl space-y-8 py-10">
      <PageHeader title="New audit" description="Enter the address of a public website. SiteInsights will crawl it and check every link it finds." />
      <Card className="p-5 sm:p-6">
        <UrlForm autoFocus />
        <p className="mt-3 text-xs text-muted-foreground">Only public http:// and https:// websites can be scanned. Local, private-network and internal addresses are rejected for security reasons.</p>
      </Card>
      <SystemNotice />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="p-5">
          <h2 className="font-semibold">What happens during a scan</h2>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>robots.txt and the XML sitemap are read.</li>
            <li>Up to {s.maxPages} pages are crawled, up to {s.maxDepth} clicks from the start page.</li>
            <li>Up to {s.maxLinksToCheck} unique link and image destinations are checked.</li>
            {checks.browser ? <li>If selected, up to {checks.browserPages} pages are opened in a real browser (Chromium){checks.accessibility ? " and tested with axe-core" : ""}.</li> : null}
            {checks.performance ? <li>If selected, the start page is measured with Google PageSpeed Insights ({checks.performanceStrategies.join(" and ")}).</li> : null}
            <li>SEO, accessibility and HTTPS rules are evaluated.</li>
          </ol>
        </Card>
        <Card className="p-5">
          <h2 className="font-semibold">Good to know</h2>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>Keep the progress page open while the scan runs (usually under {Math.ceil(s.maxDurationMs / 60000)} minutes).</li>
            <li>Pages behind a login and pages disallowed by robots.txt are not crawled.</li>
            <li>Links that block automated checks are marked “unverified”, not broken.</li>
          </ul>
          <p className="mt-3 text-sm"><Link className="font-medium text-primary hover:underline" href="/help#crawler">About the SiteInsights crawler</Link></p>
        </Card>
      </div>
    </div>
  );
}
