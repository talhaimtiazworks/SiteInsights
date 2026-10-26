import { HeroVisual } from "@/components/hero/hero-visual";
import { ButtonLink } from "@/components/ui";
import { UrlForm } from "@/components/url-form";
import { BRAND } from "@/lib/brand";
import { getConfig } from "@/lib/config/env";
import { applicationStructuredData, publicPageMetadata } from "@/lib/config/metadata";

export const metadata = publicPageMetadata("/", BRAND.category, "Find website problems. Turn real audit findings into client opportunities.");
// The public shell is prerendered and refreshed periodically; it has no user-specific data.
export const revalidate = 300;

const STEPS = [
  { n: "01", title: "Audit a site", body: "Enter a public URL. The crawler reads robots.txt and the sitemap, then follows internal links up to the audit's page limit." },
  { n: "02", title: "Check the evidence", body: "Every finding links to the page, the HTTP response or the element it came from. Live progress shows what was scanned, skipped or failed." },
  { n: "03", title: "Prioritise", body: "Issues are ranked by severity and how many pages they affect, so the fixes that matter most come first." },
  { n: "04", title: "Share and follow up", body: "Download a PDF, share a private report link, or save the site as a prospect with notes and a status." },
];

export default function LandingPage() {
  const { plans } = getConfig().plans;
  const free = plans.free;
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(applicationStructuredData()).replace(/</g, "\\u003c") }} />

      <section className="border-b" aria-labelledby="hero-heading">
        <div className="container grid gap-10 py-12 sm:py-16 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-12 lg:py-20">
          <div>
            <p className="eyebrow text-primary">Website audits for agencies and freelancers</p>
            <h1 id="hero-heading" className="mt-4 max-w-2xl text-balance text-[2.5rem] font-bold leading-[1.04] tracking-display sm:text-[3.25rem] lg:text-[3.75rem]">
              Find website problems. <span className="text-primary">Turn real audit findings into client opportunities.</span>
            </h1>
            <p className="mt-5 max-w-xl text-[1.0625rem] leading-7 text-secondary">
              SiteInsights checks public pages for broken links, SEO and technical issues. Optional browser-based accessibility and performance checks appear when enabled for this deployment, with evidence you can act on or show a client.
            </p>
            <div className="mt-7 max-w-xl">
              <UrlForm size="lg" />
              <p className="mt-3 text-xs leading-5 text-muted-foreground" data-numeric>
                Completely free — every feature included, {free.maxPagesPerAudit}-page audits whenever you need them. No card, no account required.
              </p>
            </div>
          </div>
          <figure className="relative">
            <HeroVisual />
            <figcaption className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-block h-2 w-2 bg-gold" aria-hidden="true" /> Illustration of a crawl map. Gold nodes are pages with findings.
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="container py-14 sm:py-20" aria-labelledby="workflow-heading">
        <div className="max-w-2xl">
          <span className="rule-accent" aria-hidden="true" />
          <h2 id="workflow-heading" className="mt-4 text-3xl font-semibold tracking-display sm:text-[2.25rem]">From URL to a conversation worth having</h2>
        </div>
        <ol className="mt-10 grid border-t sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.n} className={`border-b py-6 sm:pr-6 lg:border-b-0 ${i > 0 ? "lg:border-l lg:pl-6" : ""} ${i % 2 === 1 ? "sm:border-l sm:pl-6 lg:pl-6" : ""}`}>
              <span className="font-mono text-xs text-primary">{s.n}</span>
              <h3 className="mt-2 text-lg font-semibold tracking-tight">{s.title}</h3>
              <p className="mt-2 text-sm leading-6 text-secondary">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="border-y bg-tint" aria-labelledby="benefits-heading">
        <div className="container py-14 sm:py-20">
          <h2 id="benefits-heading" className="sr-only">Why SiteInsights</h2>
          <div className="grid gap-10 lg:grid-cols-3">
            <div>
              <h3 className="text-xl font-semibold tracking-tight">Evidence, not guesses</h3>
              <p className="mt-3 text-sm leading-6 text-secondary">Findings come from fixed, documented checks against real HTTP responses. Links that block bots are marked unverified, never broken. AI explanations are optional and labelled as interpretation.</p>
            </div>
            <div>
              <h3 className="text-xl font-semibold tracking-tight">Sized to the site</h3>
              <p className="mt-3 text-sm leading-6 text-secondary" data-numeric>
                Audits cover up to {free.maxPagesPerAudit} pages each with the whole page list visible before you start — at no cost.
              </p>
            </div>
            <div>
              <h3 className="text-xl font-semibold tracking-tight">Findings that open doors</h3>
              <p className="mt-3 text-sm leading-6 text-secondary">Save audited sites as prospects, rank their issues by impact, add notes and a status, and export a CSV for your own outreach. Nothing is sent on your behalf.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="container py-14 sm:py-20" aria-labelledby="free-heading">
        <div className="max-w-xl">
          <span className="rule-accent" aria-hidden="true" />
          <h2 id="free-heading" className="mt-4 text-3xl font-semibold tracking-display sm:text-[2.25rem]">Free for everyone</h2>
          <p className="mt-3 text-secondary">
            SiteInsights is a free product: audits, AI explanations, PDF reports, prospects, batch audits, share links and the free client-acquisition guide — no subscriptions, no credits, no checkout. Audits are subject only to technical safeguards (rate windows and page caps) so the service stays fast and fair for everyone.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <ButtonLink href="/audit/new">Run your first audit</ButtonLink>
            <ButtonLink href="/guide" variant="outline">Read the free guide</ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
