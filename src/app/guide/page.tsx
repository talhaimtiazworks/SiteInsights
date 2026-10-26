import Link from "next/link";
import { ButtonLink } from "@/components/ui";
import { publicPageMetadata } from "@/lib/config/metadata";
import { GUIDE_TOC } from "./data";
import {
  SectionEight, SectionEleven, SectionFifteen, SectionFive, SectionFour, SectionFourteen, SectionNine, SectionOne,
  SectionSeven, SectionSix, SectionTen, SectionThirteen, SectionThree, SectionTwelve, SectionTwo,
} from "./sections";

export const metadata = publicPageMetadata(
  "/guide",
  "The Client-Acquisition Guide — find website problems, prove them, win clients",
  "A complete, honest playbook for freelancers, developers and small agencies: audit public websites with SiteInsights, verify real findings, approach business owners professionally, and convert prospects into paying clients. Free.",
  {
    // Dedicated social card — WITHOUT og:image, Instagram et al. fall back to the small
    // in-page logo and stretch-crop it into a blurry 1.91:1 card (user-reported).
    path: "/brand/siteinsight-og-1200x630.png",
    width: 1200,
    height: 630,
    alt: "SiteInsights Client-Acquisition Guide — from a broken link to a signed client. AI-powered website auditing by TalhaImtiazWorks.",
  },
);

/**
 * /guide — the complete client-acquisition learning center.
 * Public by design (same policy as /features, /about): no session required.
 * All content is static content + existing-token styling + pure-SVG visuals;
 * the only client JS is the copy buttons and the opt-in checklist state.
 */
export default function GuidePage() {
  return (
    <div className="min-w-0">
      {/* Hero */}
      <header className="border-b border-white/10" style={{ background: "#14122A" }}>
        <div className="container max-w-5xl py-12 sm:py-16">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.3em]" style={{ color: "#03D2D2" }}>
            The SiteInsights learning center
          </p>
          <h1 className="mt-3 max-w-3xl text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-[2.6rem] lg:leading-[1.12]">
            From a broken link to a signed client:
            <span style={{ color: "#FFC422" }}> the honest client-acquisition guide.</span>
          </h1>
          <p className="mt-4 max-w-2xl text-[15.5px] leading-7" style={{ color: "rgba(255,255,255,.72)" }}>
            Find real website problems, prove them line by line, approach owners professionally, and sell fixes you can
            actually deliver. Fifteen sections, no hype, everything free — including SiteInsights itself.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <ButtonLink href="#what-is-siteinsight" size="lg">Start with section 01</ButtonLink>
            <Link
              href="/audit/new"
              className="inline-flex items-center rounded-lg border border-white/30 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            >
              Or run an audit right away
            </Link>
          </div>
          <p className="mt-4 text-[12.5px]" style={{ color: "rgba(255,255,255,.5)" }}>
            Reading time ≈ 35–45 minutes. No account needed; nothing here is tracked.
          </p>
        </div>
      </header>

      {/* Table of contents — numbered, anchored, two columns on desktop */}
      <nav aria-label="Guide contents" className="container max-w-5xl py-8 sm:py-10">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.3em] text-primary">Contents</p>
        <ol className="mt-4 grid gap-x-10 gap-y-1 sm:grid-cols-2">
          {GUIDE_TOC.map((t) => (
            <li key={t.id}>
              <a
                href={`#${t.id}`}
                className="group flex items-baseline gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--ring))]"
              >
                <span className="font-mono text-[12px] font-bold text-primary">{t.n}</span>
                <span className="text-[14.5px] font-medium leading-snug text-foreground group-hover:underline group-hover:underline-offset-4">{t.title}</span>
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {/* The fifteen sections */}
      <div className="container max-w-5xl space-y-10 pb-16 sm:space-y-14">
        <SectionOne />
        <SectionTwo />
        <SectionThree />
        <SectionFour />
        <SectionFive />
        <SectionSix />
        <SectionSeven />
        <SectionEight />
        <SectionNine />
        <SectionTen />
        <SectionEleven />
        <SectionTwelve />
        <SectionThirteen />
        <SectionFourteen />
        <SectionFifteen />
        <p className="border-t border-border/60 pt-8 text-[12.5px] text-muted-foreground">
          Illustrative ratings are labelled as such throughout. Nothing in this guide is legal, marketing or financial
          advice; cold outreach is regulated in many places — when in doubt, check the rules that apply to you.
        </p>
      </div>
    </div>
  );
}
