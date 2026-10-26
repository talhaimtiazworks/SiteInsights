import Link from "next/link";
import { ButtonLink } from "@/components/ui";
import { getConfig } from "@/lib/config/env";
import { publicPageMetadata } from "@/lib/config/metadata";
import { availableChecks } from "@/lib/services/scans";

export const metadata = publicPageMetadata("/features", "Features", "The checks SiteInsights runs, how audits work, and the reporting and client-workflow features — all free for every visitor — with their limitations.");
export const dynamic = "force-dynamic";

type Plan = "Every feature" | "Free for all";

interface Feature {
  title: string;
  body: string;
  plan: Plan;
  limits?: string;
  /** False when the operator has not enabled the required service on this server. */
  enabled?: boolean;
}

function FeatureRow({ f }: { f: Feature }) {
  return (
    <li className="grid gap-2 border-t py-6 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_9rem] md:gap-8">
      <h3 className="text-lg font-semibold leading-snug tracking-tight">{f.title}</h3>
      <div className="text-sm leading-6 text-secondary">
        <p>{f.body}</p>
        {f.limits ? (
          <p className="mt-2 text-[0.8125rem] leading-5 text-muted-foreground">
            <span className="font-mono text-[11px] uppercase tracking-wider text-charcoal">Limitation</span> {f.limits}
          </p>
        ) : null}
        {f.enabled === false ? <p className="mt-2 text-[0.8125rem] text-warning">Not enabled on this server right now.</p> : null}
      </div>
      <p className="font-mono text-[11px] uppercase tracking-wider text-primary md:text-right">{f.plan}</p>
    </li>
  );
}

export default function FeaturesPage() {
  const cfg = getConfig();
  const { plans } = cfg.plans;
  const checks = availableChecks();
  const pages = `${plans.free.maxPagesPerAudit}`;

  const auditing: Feature[] = [
    { title: "Site crawler", plan: "Every feature", body: `Follows internal links breadth-first from your start URL, reads robots.txt and XML sitemaps, normalises and de-duplicates URLs, strips tracking parameters, follows redirects and canonical links, and stays on your domain. Audits cover up to ${pages} pages.`, limits: "The HTML crawler does not run JavaScript. Pages behind logins, paywalls or bot protection can't be analysed. robots.txt rules and crawl-delay are respected, which can make large audits slower." },
    { title: "Live, honest progress", plan: "Every feature", body: "Progress shows pages discovered, queued, scanned, skipped and failed, and how many remain, straight from the saved audit state. You can leave and come back; partial results are kept with a clear reason if an audit stops early." },
    { title: "Broken links and images", plan: "Every feature", body: "Internal and external links and images found on scanned pages are checked with HEAD, falling back to GET. Redirect chains are recorded.", limits: "Sites that block automated requests are reported as unverified, never as broken." },
    { title: "Technical SEO", plan: "Every feature", body: "Titles, meta descriptions, headings, canonical tags, noindex directives, sitemaps, redirects, duplicate content signals and possible orphan pages.", limits: "Orphan pages are candidates: pages beyond the crawl limit are not seen." },
    { title: "Accessibility basics", plan: "Every feature", body: "Alt text, form labels and language attributes on every scanned page. With browser rendering enabled, axe-core tests run on rendered pages with affected elements and WCAG references.", limits: "Automated tests can't confirm WCAG conformance.", enabled: undefined },
    { title: "HTTPS and mixed content", plan: "Every feature", body: "Pages served without HTTPS, insecure mixed content, and links that send visitors from HTTPS to HTTP." },
    { title: "Browser rendering", plan: "Every feature", body: "Optionally loads key pages in an isolated Chromium worker on a mobile viewport to catch JavaScript errors, failed requests and mobile layout problems.", limits: "Limited to a few pages per audit and only when the operator has connected a browser worker.", enabled: checks.browser },
    { title: "Performance", plan: "Every feature", body: "Optionally runs Google PageSpeed Insights (Lighthouse) for the start page and shows real-user Chrome data where it exists, clearly separated from lab results.", limits: "Start page only; lab values vary between runs.", enabled: checks.performance },
  ];
  const reporting: Feature[] = [
    { title: "Findings with evidence", plan: "Every feature", body: "Each issue shows severity, the affected URLs, the exact evidence and a recommended fix. Reports state what was and wasn't evaluated." },
    { title: "JSON export", plan: "Every feature", body: "Download the verified audit data as JSON for your own tools." },
    { title: "Branded PDF report", plan: "Every feature", body: "A typeset PDF of the audit with scores, top issues and evidence, ready to send.", limits: "A technical per-visitor export window keeps the service responsive; nothing is charged." },
    { title: "AI explanations", plan: "Every feature", body: "Plain-language explanations, example fixes and an action plan, generated only from verified findings and labelled as AI interpretation.", limits: "Available only when an AI provider is configured on the server. AI can be wrong; the verified finding is always shown alongside." },
  ];
  const client: Feature[] = [
    { title: "Opportunity brief", plan: "Every feature", body: "Ranks an audit's verified issues by severity, type and how many pages they affect, lists the site's strengths, and notes caveats, so you can explain why the work matters. Useful even when a site has few issues." },
    { title: "Prospect list", plan: "Every feature", body: `Save audited sites with a status (New, Reviewing, Contacted, Converted), notes, the audit date, and contact details you enter yourself. Up to ${plans.free.maxProspects.toLocaleString("en-US")} prospects per list.`, limits: "SiteInsights doesn't find contact details or send messages. Outreach is up to you." },
    { title: "CSV export", plan: "Every feature", body: "Export prospects with their audit evidence for manual outreach or your CRM. Cells are escaped so spreadsheets can't run formulas from website content." },
    { title: "Client report links", plan: "Every feature", body: "Read-only links to a single report, with optional PDF download, that expire after 1 to 90 days and can be revoked at any time.", limits: "Anyone with the link can view that report until it expires or is revoked." },
    { title: "Batch audits", plan: "Every feature", body: `Queue up to ${plans.free.maxBatchSize} sites at once. They run one after another with the same technical safeguards as single audits.`, limits: "Batches run sequentially, not in parallel, so they take longer than a single audit." },
  ];

  return (
    <div className="container py-12 sm:py-16">
      <header className="max-w-2xl">
        <p className="eyebrow text-primary">Features</p>
        <h1 className="mt-3 text-[2.5rem] font-bold leading-[1.05] tracking-display sm:text-[3rem]">What SiteInsights actually does</h1>
        <p className="mt-4 text-[1.0625rem] leading-7 text-secondary">Every finding comes from a fixed, documented check against real responses from the site. Here is what&apos;s included — everything in SiteInsights is free for everyone — and where the technical limits are.</p>
      </header>

      {[
        ["Auditing", auditing],
        ["Reports", reporting],
        ["Client work", client],
      ].map(([title, list]) => (
        <section key={title as string} className="mt-14" aria-labelledby={`f-${title}`}>
          <div className="flex items-center gap-3">
            <span className="rule-accent" aria-hidden="true" />
            <h2 id={`f-${title}`} className="text-2xl font-semibold tracking-tight">{title as string}</h2>
          </div>
          <ul className="mt-4">
            {(list as Feature[]).map((f) => <FeatureRow key={f.title} f={f} />)}
          </ul>
        </section>
      ))}

      <section className="mt-14 border-t pt-10" aria-labelledby="not-included">
        <h2 id="not-included" className="text-xl font-semibold tracking-tight">Not included</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-secondary">SiteInsights has no third-party integrations, white-label reports, unlimited plans or automated prospecting, and it never sends email or messages to the sites you audit.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <ButtonLink href="/audit/new">Start a free audit</ButtonLink>
          <ButtonLink href="/help" variant="outline">How scanning works</ButtonLink>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">Details of every rule are in the <Link href="/help#checks" className="underline underline-offset-4">help pages</Link>.</p>
      </section>
    </div>
  );
}
