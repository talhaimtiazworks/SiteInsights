import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, ButtonLink, Card } from "@/components/ui";
import {
  AUDIT_TUTORIAL_STEPS, CALL_SCRIPTS, EMAIL_TEMPLATES, FINAL_CHECKLIST, GUIDE_TOC, MISTAKES, NICHE_DISCLAIMER,
  OBJECTIONS, OPENING_HOOKS, PRIORITY_CRITERIA, PROCESS_STEPS, REAL_PROSPECT_STATUSES, REPORT_STRUCTURE, WEAKNESSES,
} from "./data";
import {
  AcquisitionFlow, CallFlow, FunnelDiagram, NicheComparison, PriorityMatrix, ProcessTimeline,
  ReportStructureVisual, SevenDayTimeline, WeaknessChecklist,
} from "./visuals";
import { FinalChecklist, ScriptCard } from "./interactive";

/* Shared guide chrome ------------------------------------------------------- */

export function GuideSection({ id, n, title, lead, children }: { id: string; n: string; title: string; lead: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-20 border-t border-border/60 pt-10 sm:pt-14">
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.3em] text-primary">Section {n}</p>
      <h2 id={`${id}-heading`} className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">{title}</h2>
      <p className="mt-3 max-w-3xl text-[15px] leading-7 text-secondary">{lead}</p>
      <div className="mt-6 space-y-6">{children}</div>
    </section>
  );
}

function Kicker({ children }: { children: ReactNode }) {
  return <h3 className="text-base font-semibold tracking-tight">{children}</h3>;
}

function Prose({ children }: { children: ReactNode }) {
  return <div className="max-w-3xl space-y-3 text-[15px] leading-7 text-secondary">{children}</div>;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-border bg-muted/60 px-4 py-3 text-[13px] leading-6 text-secondary">
      <span className="mr-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-wider text-primary">Note</span>
      {children}
    </p>
  );
}

/* Section 1 ----------------------------------------------------------------- */

export function SectionOne() {
  return (
    <GuideSection id={GUIDE_TOC[0].id} n={GUIDE_TOC[0].n} title={GUIDE_TOC[0].title}
      lead="SiteInsights is a free website-audit platform: it crawls a public website, checks every link and image it finds, runs optional browser/accessibility/performance checks, and produces a report where every finding carries its evidence. This guide explains how freelancers, developers and small agencies use that to find and win clients — honestly.">
      <Prose>
        <p><strong className="text-foreground">What it helps you do.</strong> SiteInsights answers one question well: <em>what is verifiably wrong or weak on this public website?</em> Broken links, dead images, rendering errors, missing metadata, accessibility findings, measured page speed — each with the affected URLs, the evidence, and a recommended fix.</p>
        <p><strong className="text-foreground">Why website problems create opportunity.</strong> Most small businesses already paid for a website; they lose value when it quietly breaks. A precise, proven observation (“your booking link 404s”) is a conversation opener that generic cold pitches (“we do websites!”) never earn. The work already exists — you’re the person who can show and fix it.</p>
        <p><strong className="text-foreground">From observation to conversation.</strong> There are three different jobs: <em>finding</em> a technical problem (the tool), <em>explaining</em> its business relevance in plain language (you), and <em>persuading</em> the owner to pay for a fix (you, through trust). Confusing these stages is why most outreach fails.</p>
      </Prose>
      <AcquisitionFlow />
      <div className="grid gap-3 md:grid-cols-2">
        <Card className="p-5">
          <Kicker>What SiteInsights can establish</Kicker>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-6 text-secondary">
            <li>That specific links, images or requests fail — and where.</li>
            <li>Measured performance results under stated conditions (and whether it’s lab or field data).</li>
            <li>Automated accessibility findings per element, with WCAG references, when browser checks run.</li>
            <li>Metadata, headings, canonicals, candidate orphan pages — the crawlable facts.</li>
          </ul>
        </Card>
        <Card className="p-5">
          <Kicker>What it cannot establish</Kicker>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-6 text-secondary">
            <li>That a business loses money, rankings or customers (you cannot see their analytics).</li>
            <li>Legal compliance of any kind (accessibility scanners aren’t courts).</li>
            <li>Anything about sites behind logins, paywalls or bot protection — those are marked ”unverified”, never ”broken”.</li>
          </ul>
          <p className="mt-3 text-[13px] font-medium text-warning">It does not find clients, guarantee sales, or contact anyone for you. You do the human work; SiteInsights makes your claims provable.</p>
        </Card>
      </div>
    </GuideSection>
  );
}

/* Section 2 ----------------------------------------------------------------- */

export function SectionTwo() {
  return (
    <GuideSection id={GUIDE_TOC[1].id} n={GUIDE_TOC[1].n} title={GUIDE_TOC[1].title}
      lead="Eleven steps, end to end. The colored dots mark who acts: SiteInsights (the tool), you, or both. The table that follows gives every step's purpose, output and common mistakes.">
      <ProcessTimeline />
      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full min-w-[44rem] border-collapse text-[13.5px]">
          <thead>
            <tr className="border-b-2 border-border text-left font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium"># · Step</th>
              <th scope="col" className="py-2 pr-3 font-medium">Purpose</th>
              <th scope="col" className="py-2 pr-3 font-medium">Output</th>
              <th scope="col" className="py-2 font-medium">Common mistakes</th>
            </tr>
          </thead>
          <tbody>
            {PROCESS_STEPS.map((s) => (
              <tr key={s.n} className="border-b border-border/60 align-top">
                <th scope="row" className="py-3 pr-3 text-left leading-snug">
                  <span className="mr-1 font-mono text-[11px] text-muted-foreground">{String(s.n).padStart(2, "0")}</span>
                  {s.title}
                  <span className="mt-0.5 block">
                    <Badge>{s.actor === "tool" ? "SiteInsights" : s.actor === "both" ? "both" : "you"}</Badge>
                  </span>
                </th>
                <td className="py-3 pr-3 leading-snug text-secondary">{s.purpose}</td>
                <td className="py-3 pr-3 leading-snug text-secondary">{s.output}</td>
                <td className="py-3 leading-snug text-secondary"><ul className="list-disc pl-4">{s.mistakes.map((m) => <li key={m}>{m}</li>)}</ul></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </GuideSection>
  );
}

/* Section 3 ----------------------------------------------------------------- */

export function SectionThree() {
  return (
    <GuideSection id={GUIDE_TOC[2].id} n={GUIDE_TOC[2].n} title={GUIDE_TOC[2].title}
      lead="Approaching 'every business' is approaching no one. A niche lets you learn one vocabulary, repeat one offer, and get measurably better with every conversation.">
      <Prose>
        <p>Pick by five criteria: how often sites in that market are thin, whether the business can pay, what the fix is worth to them, how easily you can legitimately reach a decision-maker, and — most important — whether <em>you</em> can deliver the fix you’re about to point at. A niche you can’t serve is a trap, not a market.</p>
      </Prose>
      <Kicker>Illustrative comparison</Kicker>
      <NicheComparison />
      <Note>{NICHE_DISCLAIMER}</Note>
    </GuideSection>
  );
}

/* Section 4 ----------------------------------------------------------------- */

export function SectionFour() {
  return (
    <GuideSection id={GUIDE_TOC[3].id} n={GUIDE_TOC[3].n} title={GUIDE_TOC[3].title}
      lead="A repeatable, ethical prospecting method: source candidates only from public places, then look for problems you can prove. Here is the visual checklist first — then every category in detail.">
      <Prose>
        <p><strong className="text-foreground">Where candidates come from.</strong> Search engines (queries like <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">“plumber” + your city</code>), public business directories and listings, companies’ own websites and public contact pages, and relevant professional networks. If you’d hesitate to explain how you found someone, don’t use the source.</p>
      </Prose>
      <WeaknessChecklist items={WEAKNESSES} />
      <ol className="space-y-5">
        {WEAKNESSES.map((w, i) => (
          <li key={w.title} id={`weakness-${i + 1}`} className="scroll-mt-20 rounded-xl border border-border bg-card p-4 sm:p-5">
            <h4 className="text-[15px] font-semibold"><span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>{w.title}</h4>
            <dl className="mt-2.5 grid gap-x-8 gap-y-2 text-[13.5px] leading-6 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))]">
              <div><dt className="font-mono text-[10.5px] uppercase tracking-wider text-primary">1 · What to inspect</dt><dd className="mt-0.5 text-secondary">{w.inspect}</dd></div>
              <div><dt className="font-mono text-[10.5px] uppercase tracking-wider text-primary">2 · How to verify</dt><dd className="mt-0.5 text-secondary">{w.verify}</dd></div>
              <div><dt className="font-mono text-[10.5px] uppercase tracking-wider text-primary">3 · Why it may matter</dt><dd className="mt-0.5 text-secondary">{w.matters}</dd></div>
              <div><dt className="font-mono text-[10.5px] uppercase tracking-wider text-primary">4 · Evidence to collect</dt><dd className="mt-0.5 text-secondary">{w.evidence}</dd></div>
              <div><dt className="font-mono text-[10.5px] uppercase tracking-wider text-danger">5 · Do not claim</dt><dd className="mt-0.5 text-secondary">{w.dont}</dd></div>
            </dl>
          </li>
        ))}
      </ol>
      <Note>An SEO warning is not automatically a ranking penalty; a performance lab score does not prove lost revenue; and no accessibility scanner can establish legal noncompliance. Present these as opportunities and risks — measured, dated, and reproducible.</Note>
    </GuideSection>
  );
}

/* Section 5 ----------------------------------------------------------------- */

export function SectionFive() {
  return (
    <GuideSection id={GUIDE_TOC[4].id} n={GUIDE_TOC[4].n} title={GUIDE_TOC[4].title}
      lead="This walkthrough uses only the interface that exists in this deployment of SiteInsights. Where an option is operator-dependent, the interface says so — nothing here is invented.">
      <ol className="space-y-3">
        {AUDIT_TUTORIAL_STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-4 rounded-xl border border-border bg-card p-4 sm:p-5">
            <span aria-hidden="true" className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-[rgb(var(--primary))] font-mono text-[12px] font-bold text-[rgb(var(--primary-foreground))]">{i + 1}</span>
            <div className="min-w-0">
              <h4 className="text-[15px] font-semibold">{s.title}</h4>
              <p className="mt-1 text-[14px] leading-6 text-secondary">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4"><Kicker>Start here</Kicker><p className="mt-1.5 text-[13.5px] leading-6 text-secondary">The <Link href="/audit/new" className="font-medium text-primary underline underline-offset-4">New audit</Link> page takes any public URL, crawls the site, checks every link and image — free, no plan required.</p></Card>
        <Card className="p-4"><Kicker>Deliver here</Kicker><p className="mt-1.5 text-[13.5px] leading-6 text-secondary">From the finished audit: branded <strong className="text-foreground">PDF report</strong>, raw JSON export, or an expiring read-only <strong className="text-foreground">client report link</strong> (“Client report links” on the audit page). </p></Card>
        <Card className="p-4"><Kicker>Track here</Kicker><p className="mt-1.5 text-[13.5px] leading-6 text-secondary">Dashboard → <Link href="/dashboard/prospects" className="font-medium text-primary underline underline-offset-4">Prospects</Link> keeps your leads; saving a finished audit attaches its verified findings automatically.</p></Card>
      </div>
      <Note>What SiteInsights does <strong>not</strong> do: crawl past logins or paywalls, run JavaScript in the plain HTML crawler (enable browser rendering for that), or contact anyone. Audits of large sites respect robots.txt crawl-delay and page caps — good; you’re auditing prospects, not attacking them.</Note>
    </GuideSection>
  );
}

/* Section 6 ----------------------------------------------------------------- */

export function SectionSix() {
  return (
    <GuideSection id={GUIDE_TOC[5].id} n={GUIDE_TOC[5].n} title={GUIDE_TOC[5].title}
      lead="A 200-warning audit is not a stronger sales asset — it's noise. Owners buy specific, proven, explainable fixes. Score each finding by five things, then plot it.">
      <ul className="flex flex-wrap gap-2">
        {PRIORITY_CRITERIA.map((c) => (
          <li key={c.label} className="rounded-lg border border-border bg-card px-3 py-2 text-[12.5px]">
            <span className="font-semibold">{c.label}</span>
            <span className="ml-2 text-muted-foreground">{c.hint}</span>
          </li>
        ))}
      </ul>
      <PriorityMatrix />
      <Prose>
        <p>This matrix is a <strong className="text-foreground">prioritization aid, not a validated prediction</strong> — the labels are illustrative placements of typical findings, yours to redraw per prospect. The discipline is the point: high-impact + high-confidence issues lead the report; plausible-but-unproven issues become questions, not claims.</p>
        <p>Two findings can look identical in a warning list and be worth a fortune apart to a business. ”Broken link” on a 2019 blog post is trivia; the same break on the ”Contact us” button is worth a phone call. <strong className="text-foreground">Evidence and context outrank raw warning count, every time.</strong></p>
      </Prose>
    </GuideSection>
  );
}

/* Section 7 ----------------------------------------------------------------- */

export function SectionSeven() {
  return (
    <GuideSection id={GUIDE_TOC[6].id} n={GUIDE_TOC[6].n} title={GUIDE_TOC[6].title}
      lead="The deliverable is a report a nontechnical owner understands in two minutes. SiteInsights already produces the technical core — the branded PDF export or an expiring client report link — and this structure wraps it.">
      <ReportStructureVisual parts={REPORT_STRUCTURE} />
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {REPORT_STRUCTURE.map((r, i) => (
          <li key={r.part} className="rounded-lg border border-border/70 bg-card px-3.5 py-3">
            <p className="text-[13px] font-semibold"><span className="mr-1.5 font-mono text-[10.5px] text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>{r.part}</p>
            <p className="mt-1 text-[12.5px] leading-5 text-secondary">{r.body}</p>
          </li>
        ))}
      </ol>
      <Kicker>What to avoid</Kicker>
      <ul className="grid gap-2 text-[14px] leading-7 text-secondary sm:grid-cols-2">
        {[
          "Dumping dozens of low-value warnings — pick the verified few.",
          "Unsupported revenue or SEO promises (\"this is costing you sales\").",
          "Presenting automated findings as manually verified facts — state both.",
          "Fear-based language. Calm precision converts better and keeps you credible.",
          "Confidential data or unnecessary personal details in the report.",
        ].map((t) => <li key={t} className="flex gap-2 rounded-lg border border-border/70 bg-card px-3 py-2.5"><span aria-hidden="true" className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-[rgb(var(--danger))]" />{t}</li>)}
      </ul>
      <Note>No fabricated samples here: your first real audit of a permission-given site is your template. If you ever show a fictional example, label every business detail in it as illustrative.</Note>
      <div className="rounded-xl border border-border bg-muted/50 px-4 py-3 text-[13.5px] leading-6 text-secondary">
        <strong className="text-foreground">Real export paths:</strong> on a finished audit page — ”Download PDF” (branded, typeset), ”Export JSON” (raw data for your tools), and <strong className="text-foreground">Client report links</strong>: read-only links that expire and can be revoked, so the report stays yours. See <Link href="/features" className="font-medium text-primary underline underline-offset-4">Features</Link> for the honest limitations of each.
      </div>
    </GuideSection>
  );
}

/* Section 8 ----------------------------------------------------------------- */

export function SectionEight() {
  return (
    <GuideSection id={GUIDE_TOC[7].id} n={GUIDE_TOC[7].n} title={GUIDE_TOC[7].title}
      lead="Before the first call, an owner who googles you must find one consistent, credible professional — SiteInsights does not create these profiles; you do, once, before outreach.">
      <div className="grid gap-3 md:grid-cols-2">
        <Card className="p-5">
          <Kicker>Set up once, keep consistent</Kicker>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[14px] leading-6 text-secondary">
            <li>One professional name, used identically everywhere.</li>
            <li>A niche label (“websites for local service businesses”), not ”full-stack everything”.</li>
            <li>A one-line value proposition: the outcome, not the stack.</li>
            <li>A professional address at your own domain or a respectable provider — one you check.</li>
            <li>A portfolio: three short case notes beat ten screenshots.</li>
            <li>GitHub or equivalent work samples where your audience can judge code.</li>
            <li>LinkedIn or another professional profile matching the same identity.</li>
            <li>A simple services page: what you do, what you don’t, how to book a conversation.</li>
          </ul>
        </Card>
        <Card className="p-5">
          <Kicker>Starting without testimonials</Kicker>
          <p className="mt-2 text-[14px] leading-6 text-secondary">Ask prospects to verify instead of trusting: include reproduction steps with every finding, offer a five-minute screen-share walkthrough, publish one honest before/after of your own site work. Verified public behavior is a stronger signal than unverifiable praise.</p>
          <Kicker><span className="mt-4 block">Adaptable profile lines</span></Kicker>
          <ul className="mt-2 space-y-2 text-[13px] leading-5 text-secondary">
            <li className="rounded-lg bg-muted/70 px-3 py-2">Headline — ”I fix the website problems that quietly cost local [niche] businesses inquiries.”</li>
            <li className="rounded-lg bg-muted/70 px-3 py-2">Bio — ”Web developer in [city]. I find, verify and fix website issues for [niche]. Every claim I make ships with instructions to reproduce it.”</li>
            <li className="rounded-lg bg-muted/70 px-3 py-2">Value prop — ”A working website, verified: I show you exactly what fails, where, and what the fix costs — before you pay anything.”</li>
          </ul>
        </Card>
      </div>
    </GuideSection>
  );
}

/* Section 9 ----------------------------------------------------------------- */

export function SectionNine() {
  return (
    <GuideSection id={GUIDE_TOC[8].id} n={GUIDE_TOC[8].n} title={GUIDE_TOC[8].title}
      lead="A professional call is 60 seconds of courtesy plus one verified fact. Research the business first, identify yourself honestly, and make it easy to say no — that's what makes 'yes' mean something.">
      <ol className="grid gap-2 text-[14px] leading-6 text-secondary sm:grid-cols-2">
        {[
          ["Research first", "Read the site, note the business's actual name and service, know your one verified finding."],
          ["Identify yourself", "Real name, real trade, real purpose. No agency costume you don't have."],
          ["Ask for the moment", "\"Did I catch you at an impossible time?\" — and mean it when the answer is yes."],
          ["One specific observation", "The verified finding in one plain-language sentence."],
          ["Plain relevance", "\"…which may stop visitors reaching your booking page\" — say why it might matter, without promises."],
          ["Ask permission to send", "Offer the one-page write-up or the report link only after they agree."],
          ["Agree the follow-up", "\"I'll email today; if nothing comes of it I'll call once more on Thursday — fair?\""],
          ["Thank and release", "Whatever the answer, thank them and honor it."],
        ].map(([t, d], i) => (
          <li key={t} className="flex gap-3 rounded-xl border border-border bg-card p-4">
            <span aria-hidden="true" className="flex h-6 w-6 flex-none items-center justify-center rounded-full font-mono text-[11px] font-bold" style={{ background: "#FFC422", color: "#14122A" }}>{i + 1}</span>
            <div><p className="font-semibold text-foreground text-[13.5px]">{t}</p><p className="mt-0.5 text-[13px]">{d}</p></div>
          </li>
        ))}
      </ol>
      <CallFlow />
      <Kicker>Scripts for the ten situations you’ll actually meet</Kicker>
      <div className="grid gap-3 lg:grid-cols-2">
        {CALL_SCRIPTS.map((s) => <ScriptCard key={s.id} title={s.id.replace(/-/g, " ")} scene={s.scene} text={s.text} />)}
      </div>
      <Note>No script here claims the site is ”losing customers”, ”killing rankings”, or ”scaring visitors” — because you cannot verify any of those. Specificity is what earns attention; fear is what burns it.</Note>
    </GuideSection>
  );
}

/* Section 10 ---------------------------------------------------------------- */

export function SectionTen() {
  return (
    <GuideSection id={GUIDE_TOC[9].id} n={GUIDE_TOC[9].n} title={GUIDE_TOC[9].title}
      lead="An opening hook works when it proves, in one breath, that you saw something real. Five adaptable openers — each with the verification it requires before you may use it.">
      <div className="space-y-4">
        {OPENING_HOOKS.map((h) => (
          <article key={h.id} className="overflow-hidden rounded-xl border border-white/10" style={{ background: "#1B1931" }}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-5 py-3" style={{ background: "#44174E" }}>
              <h4 className="text-[14px] font-bold text-white">{h.title}</h4>
            </div>
            <div className="p-5">
              <blockquote className="rounded-lg p-4 text-[14.5px] leading-7 text-white" style={{ background: "#241D3D", borderLeft: "4px solid #FFC422" }}>
                {h.text}
              </blockquote>
              <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-5">
                {([["When to use it", h.when], ["Verify first", h.verify], ["Personalize it", h.personalize], ["Say next", h.next], ["Never", h.avoid]] as const).map(([label, value]) => (
                  <div key={label}>
                    <dt className="font-mono text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#03D2D2" }}>{label}</dt>
                    <dd className="mt-0.5 text-[12.5px] leading-5 text-white/75">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </article>
        ))}
      </div>
    </GuideSection>
  );
}

/* Section 11 ---------------------------------------------------------------- */

export function SectionEleven() {
  return (
    <GuideSection id={GUIDE_TOC[10].id} n={GUIDE_TOC[10].n} title={GUIDE_TOC[10].title}
      lead="The email after the call is short, personal and provable. It references the conversation only if the conversation happened, carries one or two verified findings, and proposes exactly one next step.">
      <div className="grid gap-3">
        {EMAIL_TEMPLATES.map((t) => <ScriptCard key={t.id} title={t.scene} text={t.text} />)}
      </div>
      <Note>“Requested no further contact” is not a template — it’s a deletion. Honoring that is both the ethical floor and, in many jurisdictions, the legal one.</Note>
    </GuideSection>
  );
}

/* Section 12 ---------------------------------------------------------------- */

export function SectionTwelve() {
  return (
    <GuideSection id={GUIDE_TOC[11].id} n={GUIDE_TOC[11].n} title={GUIDE_TOC[11].title}
      lead="Every objection is a request for either proof, price, or peace. Answer the one that was asked. Sell verified fixes and useful improvements — never a frightening audit score.">
      <ol className="space-y-3">
        {OBJECTIONS.map((o) => (
          <li key={o.quote} className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <p className="text-[14.5px] font-semibold">“{o.quote}”</p>
            <p className="mt-1.5 text-[14px] leading-6 text-secondary">{o.answer}</p>
            <p className="mt-1.5 font-mono text-[10.5px] uppercase tracking-wider text-primary">{o.principle}</p>
          </li>
        ))}
      </ol>
      <Card className="p-5">
        <Kicker>The small first project</Kicker>
        <p className="mt-2 text-[14px] leading-7 text-secondary">Propose the smallest unit of work that removes the verified problem: the fix(es), the deliverables (“form works, emails arrive, you test it”), the timeframe, and the price — in writing. Estimate effort honestly; if it costs them less to have their current developer do it, say so. You are building a client book, not a single invoice.</p>
      </Card>
    </GuideSection>
  );
}

/* Section 13 ---------------------------------------------------------------- */

export function SectionThirteen() {
  return (
    <GuideSection id={GUIDE_TOC[12].id} n={GUIDE_TOC[12].n} title={GUIDE_TOC[12].title}
      lead="Outreach that isn't tracked becomes spam without you noticing. Keep exactly one pipeline, keep it tiny, and let it tell you when to stop.">
      <FunnelDiagram />
      <div className="grid gap-3 md:grid-cols-2">
        <Card className="p-5">
          <Kicker>Tracking it in SiteInsights — yes, really</Kicker>
          <p className="mt-2 text-[14px] leading-6 text-secondary">Dashboard → <Link href="/dashboard/prospects" className="font-medium text-primary underline underline-offset-4">Prospects</Link> is a real lead tracker with statuses ({REAL_PROSPECT_STATUSES.join(", ")}), search, CSV import/export, and deletion. Save a finished audit for a website and its verified findings attach to that prospect automatically. It stores leads you add — it doesn’t scrape them for you.</p>
        </Card>
        <Card className="p-5">
          <Kicker>Or a manual table</Kicker>
          <div className="mt-2 overflow-x-auto -mx-1 px-1">
            <table className="w-full min-w-[24rem] border-collapse text-[12.5px]">
              <thead><tr className="border-b border-border text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {["Business", "Verified finding", "Stage", "Next action", "Date"].map((c) => <th key={c} scope="col" className="py-1.5 pr-2 font-medium">{c}</th>)}
              </tr></thead>
              <tbody className="text-secondary">
                <tr className="border-b border-border/60"><td className="py-2 pr-2">Maple Dental Studio <span className="text-muted-foreground">(fictional example)</span></td><td className="py-2 pr-2">“Book online” link → 404 (reproduced)</td><td className="py-2 pr-2">Contacted</td><td className="py-2 pr-2">Follow up once</td><td className="py-2">Thu</td></tr>
                <tr><td className="py-2 pr-2">Harbor Bakery <span className="text-muted-foreground">(fictional example)</span></td><td className="py-2 pr-2">Menu images fail on mobile</td><td className="py-2 pr-2">Report sent</td><td className="py-2 pr-2">Await reply — stop after second nudge</td><td className="py-2">Mon</td></tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <Kicker>Responsible follow-up</Kicker>
      <ul className="grid gap-2 text-[14px] leading-6 text-secondary sm:grid-cols-2">
        {[
          "One contact, then at most one or two spaced follow-ups; a decline or an opt-out is final.",
          "Know the marketing rules that apply where you and the prospect are (cold-call windows, e-mail identification, do-not-call registries).",
          "Keep the minimum data: business details and the contact channel you actually used — not dossiers.",
          "Store contact details safely; delete them when the prospect is closed or asks (Prospects supports deletion).",
        ].map((t) => <li key={t} className="flex gap-2 rounded-lg border border-border/70 bg-card px-3 py-2.5"><span aria-hidden="true" className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-[rgb(var(--primary))]" />{t}</li>)}
      </ul>
    </GuideSection>
  );
}

/* Section 14 ---------------------------------------------------------------- */

export function SectionFourteen() {
  return (
    <GuideSection id={GUIDE_TOC[13].id} n={GUIDE_TOC[13].n} title={GUIDE_TOC[13].title}
      lead="One focused week beats a month of 'someday'. The targets below are adjustable examples — not promised results — and the last day is for learning, not only for sending.">
      <SevenDayTimeline />
      <Prose>
        <p><strong className="text-foreground">Review without folklore.</strong> After the week: Which opener earned the most responses? Which finding type got follow-through? Which niche guessed wrong? Outreach volume is a cost, not a result — the result is conversations that reference your evidence.</p>
        <p>If nobody engaged, don’t double the volume — change one variable: a sharper niche, a single clearer finding, a shorter email. Then run the week again.</p>
      </Prose>
    </GuideSection>
  );
}

/* Section 15 ---------------------------------------------------------------- */

export function SectionFifteen() {
  return (
    <GuideSection id={GUIDE_TOC[14].id} n={GUIDE_TOC[14].n} title={GUIDE_TOC[14].title}
      lead="Ten failure patterns cover nearly everything that goes wrong. Then: the checklist, and the one action that starts it all.">
      <ol className="grid gap-2 sm:grid-cols-2">
        {MISTAKES.map((m, i) => (
          <li key={m.bad} className="flex gap-3 rounded-xl border border-border bg-card p-4">
            <span aria-hidden="true" className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: "#662249" }}>{i + 1}</span>
            <div className="min-w-0">
              <p className="text-[13.5px] font-semibold leading-snug">{m.bad}</p>
              <p className="mt-1 text-[12.5px] leading-5 text-secondary">{m.fix}</p>
            </div>
          </li>
        ))}
      </ol>
      <Kicker>The prospecting checklist — check each one, it stays saved in this browser</Kicker>
      <FinalChecklist items={FINAL_CHECKLIST} />
      <div className="rounded-2xl p-6 text-center sm:p-10" style={{ background: "#1B1931" }}>
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.3em]" style={{ color: "#03D2D2" }}>Ready?</p>
        <h3 className="mx-auto mt-2 max-w-lg text-xl font-bold text-white sm:text-2xl">Find one business, verify one real problem, and make one professional call.</h3>
        <p className="mx-auto mt-2 max-w-md text-[13.5px] leading-6" style={{ color: "rgba(255,255,255,.7)" }}>Everything starts with an audit you can defend line by line. SiteInsights is free — the first one takes a minute.</p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <ButtonLink href="/audit/new" size="lg">Run your first audit</ButtonLink>
          <Link href="/features" className="text-sm font-semibold text-white underline decoration-[#FFC422] decoration-2 underline-offset-4 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80">See what the audit checks →</Link>
        </div>
      </div>
    </GuideSection>
  );
}
