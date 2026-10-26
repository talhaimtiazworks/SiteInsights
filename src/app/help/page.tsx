import { publicPageMetadata } from "@/lib/config/metadata";
import Link from "next/link";
import { SeverityBadge } from "@/components/badges";
import { PageHeader } from "@/components/ui";
import { ALL_RULES } from "@/lib/audit/rules";
import { CATEGORIES, CATEGORY_LABELS, SEVERITIES } from "@/lib/audit/types";
import { SCORE_FORMULA_VERSION } from "@/lib/audit/scoring";
import { getConfig } from "@/lib/config/env";
import { backgroundMode } from "@/lib/services/background";

export const metadata = publicPageMetadata("/help", "Help & documentation", "How SiteInsights scans websites, what each check means, how scores are calculated and how AI is used.");

const SEVERITY_TEXT: Record<string, string> = {
  critical: "Prevents the site or important pages from working or being indexed. Fix immediately.",
  high: "A clear defect that affects visitors or search visibility, such as broken internal links or missing titles.",
  medium: "A meaningful problem worth fixing soon, such as missing meta descriptions or images without alt text.",
  low: "A minor issue or best-practice gap with limited impact.",
  info: "An observation or an item that needs human review. It does not reduce scores.",
};

const LINK_STATUSES: Array<[string, string, string]> = [
  ["OK", "2xx response (directly or after redirects).", "Fine"],
  ["Redirect", "The link works but goes through one or more redirects. Updating it to the final URL is recommended.", "Fine"],
  ["Not found (404/410)", "The destination does not exist.", "Broken"],
  ["Server error (5xx)", "The destination server failed to respond correctly.", "Broken"],
  ["DNS error", "The domain name does not resolve.", "Broken"],
  ["TLS error", "The HTTPS certificate or connection is invalid.", "Broken"],
  ["Redirect loop / too many redirects", "The redirect chain never reaches a page.", "Broken"],
  ["Invalid URL", "The link cannot be parsed or uses an unsupported format.", "Broken"],
  ["Blocked (401/403/429, bot protection)", "The site refused our automated request. The link may work for people.", "Unverified"],
  ["Other 4xx", "The server rejected the request, possibly only for automated clients.", "Unverified"],
  ["Timeout / connection error", "No timely response. It may be temporary.", "Unverified"],
  ["Unsafe destination", "The link points to a private or internal network address, which we never request.", "Not requested"],
  ["Disallowed by robots.txt / not checked", "Internal URL disallowed for crawlers, or the link-check limit or time limit was reached.", "Not requested"],
];

export default function HelpPage() {
  const cfg = getConfig();
  const bg = backgroundMode();
  const s = cfg.scanner;
  const plans = cfg.plans.plans;
  const toc = [
    ["how", "How scanning works"],
    ["crawler", "About the crawler"],
    ["browser", "Browser rendering"],
    ["performance", "Performance"],
    ["accessibility", "Accessibility"],
    ["checks", "Checks we run"],
    ["severity", "Severity levels"],
    ["links", "Link statuses"],
    ["scoring", "How scores are calculated"],
    ["ai", "AI and privacy"],
    ["storage", "Data storage"],
    ["limitations", "Known limitations"],
    ["faq", "FAQ"],
  ];
  return (
    <div className="container py-10">
      <PageHeader title="Help & documentation" description="Everything SiteInsights does, explained." />
      <div className="mt-8 grid gap-10 lg:grid-cols-[14rem_1fr]">
        <nav className="hidden lg:block" aria-label="On this page">
          <ul className="sticky top-24 space-y-1 text-sm">
            {toc.map(([id, label]) => <li key={id}><a href={`#${id}`} className="block rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">{label}</a></li>)}
          </ul>
        </nav>
        <article className="prose-doc min-w-0 max-w-3xl">
          <h2 id="how">How scanning works</h2>
          <ol>
            <li><strong>Validation.</strong> The URL must use http or https and resolve to a public internet address. Local, private-network, link-local and cloud-metadata addresses are refused. This is enforced by resolving DNS and checking every resolved IP address — again on every redirect and at connection time — not just by inspecting the URL text.</li>
            <li><strong>Discovery.</strong> We read <code>/robots.txt</code> and any sitemaps it lists (or <code>/sitemap.xml</code>), including sitemap index files, up to {s.maxSitemapFiles} sitemap files.</li>
            <li><strong>Crawling.</strong> Starting from your URL we follow links on the same website (the same host and its <code>www</code> variant) breadth-first, up to the audit&apos;s page limit ({plans.free.maxPagesPerAudit} pages) and depth ({plans.free.maxDepth} clicks). You can choose a smaller limit when you start an audit. URLs are normalised (lower-case host, default ports and fragments removed, tracking parameters stripped) so each page is fetched once.</li>
            <li><strong>Link checking.</strong> Up to {plans.free.maxLinksToCheck} unique destinations found on crawled pages (internal and external links and images) are checked with a <code>HEAD</code> request, falling back to <code>GET</code> when servers do not support <code>HEAD</code>.</li>
            <li><strong>Browser rendering (optional).</strong> When the operator has connected a browser worker, up to {cfg.browser.maxPagesPerScan} pages are also loaded in an isolated Chromium browser on a mobile viewport to find JavaScript errors, failed requests, broken images, content and links that only appear after JavaScript runs, and mobile layout problems. axe-core accessibility tests run on the same pages. See <a href="#browser">Browser rendering</a>.</li>
            <li><strong>Performance (optional).</strong> When enabled, the start page is tested with Google PageSpeed Insights (Lighthouse) for mobile and/or desktop, together with real-user Chrome UX Report data where it exists. See <a href="#performance">Performance</a>.</li>
            <li><strong>Analysis.</strong> Deterministic rules evaluate the collected data and produce findings with evidence. Scores are calculated from those findings.</li>
          </ol>
          <p>Scans run in short, resumable steps (each well under a minute), so they work on serverless hosting. Every audit is saved before work starts and after each step. {bg === "full" ? "They keep running on the server after you close the page." : bg === "limited" ? "They keep running on the server for a while after you close the page; if one pauses, it resumes from the last saved step when you reopen it." : "On this server they advance while the progress page is open and resume from the last saved step when you return."} The whole scan is limited to {Math.round(s.maxDurationMs / 60000)} minutes; anything not finished by then is reported as &quot;not checked&quot;.</p>

          <h2 id="crawler">About the crawler</h2>
          <p>Requests are sent with this user agent:</p>
          <pre className="whitespace-pre-wrap break-all"><code>{s.userAgent}</code></pre>
          <ul>
            <li>The SiteInsights crawler retains the technical token <code>SiteLensAI</code> for compatibility: existing robots.txt rules for that token (or <code>*</code>) are obeyed. If the start URL is disallowed, the scan stops. A <code>Crawl-delay</code> up to a few seconds is honoured.</li>
            <li>No more than {s.concurrency} requests run at once, with at least {s.hostMinIntervalMs} ms between requests to the same host.</li>
            <li>Each request times out after {Math.round(s.requestTimeoutMs / 1000)} s; responses larger than {Math.round(s.maxBodyBytes / 1_000_000)} MB are truncated; at most {s.maxRedirects} redirects are followed.</li>
            <li>Login, account, cart and admin areas, calendar-style and faceted parameter URLs, and other likely crawler traps are skipped.</li>
            <li>Only GET and HEAD requests are made and forms are never submitted. The HTML crawler does not execute JavaScript; optional browser rendering runs in a separate, isolated worker (never inside the SiteInsights app).</li>
          </ul>

          <h2 id="browser">Browser rendering</h2>
          <p>Many sites build their pages with JavaScript. When browser rendering is available, a small number of crawled pages (up to {cfg.browser.maxPagesPerScan} per audit, starting with the start page) are opened in headless Chromium with a {"390×844"} mobile viewport. For each page we wait for the page to load and the network to settle (bounded by a {Math.round(cfg.browser.navigationTimeoutMs / 1000)} s navigation timeout), then record:</p>
          <ul>
            <li>uncaught JavaScript errors and console errors;</li>
            <li>failed requests (scripts, styles, images, API calls) and images that fail to load;</li>
            <li>text and links that exist only after JavaScript runs, and titles, descriptions, canonicals or robots directives that JavaScript changes;</li>
            <li>mobile problems: horizontal scrolling, text smaller than 12&nbsp;px and tap targets smaller than 24&nbsp;px.</li>
          </ul>
          <p>The browser uses the same safety rules as the crawler: every navigation, redirect and sub-resource request goes through a filtering proxy that only allows public internet addresses, so a page cannot make the browser reach private networks or cloud metadata services. Requests blocked this way are listed as &quot;blocked for safety&quot;, not as site errors. Each page has a request budget and a hard time limit; service workers, downloads, WebRTC and QUIC are disabled. If the worker is unavailable or a page cannot be rendered, the audit continues with the HTML crawler and the report says what was not evaluated.</p>

          <h2 id="performance">Performance</h2>
          <p>Performance is measured on the start page only, using Google PageSpeed Insights. Reports always show where each number comes from:</p>
          <ul>
            <li><strong>Lab data</strong> — one Lighthouse page load in a simulated environment: Performance score, Largest Contentful Paint (LCP), Cumulative Layout Shift (CLS), First Contentful Paint, Total Blocking Time (TBT) and Speed Index, plus page weight, render-blocking resources, unused JavaScript, image and caching opportunities. Lab results vary between runs.</li>
            <li><strong>Field data</strong> — the 75th percentile of real Chrome users over 28 days from the Chrome UX Report: LCP, Interaction to Next Paint (INP) and CLS. Pages without enough traffic use whole-site data (labelled as such) or show no field data at all.</li>
          </ul>
          <p>INP can only be measured from real users. TBT is a lab indicator of main-thread blocking and is never presented as INP. When a test cannot run (not configured, quota exhausted, timeout or a page Lighthouse cannot load), performance is shown as <strong>Not evaluated</strong> — no values are estimated.</p>

          <h2 id="accessibility">Accessibility</h2>
          <p>Accessibility findings come from two sources: HTML checks on every crawled page (missing alt text, form labels, language, headings) and, when browser rendering is available, the open-source <a href="https://github.com/dequelabs/axe-core" rel="noopener noreferrer" target="_blank">axe-core</a> engine run against the rendered page (WCAG 2.0–2.2 A/AA rules plus best practices). Each axe finding lists the rule, the affected elements (CSS selectors and HTML snippets), the impact, the WCAG success criteria and a fix. When both sources report the same problem on the same pages, it is listed once.</p>
          <p><strong>Automated tests find only part of all accessibility barriers.</strong> These results do not establish WCAG conformance or legal compliance, and are not a legal assessment. Manual testing — keyboard use, screen readers, zoom and real users — is still needed.</p>

          <h2 id="checks">Checks we run</h2>
          <p>Each finding is classified as an <strong>error</strong> (a definite technical defect), a <strong>recommendation</strong> (a best-practice improvement) or an <strong>observation</strong> (informational or needs human review).</p>
          {CATEGORIES.map((c) => {
            const rules = ALL_RULES.filter((r) => r.category === c);
            if (!rules.length) return null;
            return (
              <section key={c}>
                <h3>{CATEGORY_LABELS[c]}</h3>
                <div className="not-prose overflow-x-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr><th className="px-3 py-2 font-medium">Check</th><th className="px-3 py-2 font-medium">Default severity</th><th className="px-3 py-2 font-medium">Type</th></tr>
                    </thead>
                    <tbody className="divide-y">
                      {rules.map((r) => (
                        <tr key={r.id} className="align-top">
                          <td className="px-3 py-2"><span className="font-medium">{r.title}</span><span className="mt-0.5 block text-xs text-muted-foreground">{r.detectionMethod}</span></td>
                          <td className="px-3 py-2"><SeverityBadge severity={r.baseSeverity} />{r.severityFor ? <span className="mt-1 block text-xs text-muted-foreground">context-dependent</span> : null}</td>
                          <td className="px-3 py-2 capitalize text-muted-foreground">{r.type}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}

          <h2 id="severity">Severity levels</h2>
          <p>Severity is assigned by fixed rules, so the same site always gets the same severities. AI may <em>suggest</em> a different severity in its explanation, but never changes the recorded one.</p>
          <ul className="not-prose space-y-2">
            {SEVERITIES.map((sv) => <li key={sv} className="flex items-start gap-3 text-sm"><SeverityBadge severity={sv} className="mt-0.5 shrink-0" /><span>{SEVERITY_TEXT[sv]}</span></li>)}
          </ul>

          <h2 id="links">Link statuses</h2>
          <p>A link is only reported as <strong>broken</strong> when the evidence is conclusive. Sites that block automated requests (HTTP 401, 403, 429 or bot-protection pages) are reported as <strong>unverified</strong>, never as broken.</p>
          <div className="not-prose overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Meaning</th><th className="px-3 py-2 font-medium">Reported as</th></tr></thead>
              <tbody className="divide-y">{LINK_STATUSES.map(([a, b, c]) => <tr key={a} className="align-top"><td className="px-3 py-2 font-medium">{a}</td><td className="px-3 py-2 text-muted-foreground">{b}</td><td className="px-3 py-2">{c}</td></tr>)}</tbody>
            </table>
          </div>

          <h2 id="scoring">How scores are calculated</h2>
          <p>Each category ({CATEGORIES.map((c) => CATEGORY_LABELS[c]).join(", ")}) receives a score from 0 to 100 using formula version {SCORE_FORMULA_VERSION}:</p>
          <pre><code>{`score = max(0, round(100 − Σ penalty))

penalty (per check that produced findings)
  = weight(highest severity of that check)
    × (0.5 + 0.5 × min(1, affected pages ÷ HTML pages scanned))

weight: critical 30 · high 15 · medium 7 · low 3 · info 0`}</code></pre>
          <p>So a problem on every page costs the full weight, and a problem on a single page of many costs about half. For browser and axe-core findings the denominator is the number of pages that were successfully rendered, not every crawled page. The <strong>Performance</strong> score is the Lighthouse lab score of the start page (mobile when available, otherwise desktop). A category with no applicable data (for example, browser rendering or performance testing was unavailable) shows <strong>Not evaluated</strong> instead of a number and is not counted as 0 or 100. Scores summarise this scan only — they are not a ranking prediction or an industry benchmark.</p>

          <h2 id="ai">AI and privacy</h2>
          <ul>
            <li>AI is optional. All findings, evidence and scores are produced without AI.</li>
            <li>When you request an explanation or summary, SiteInsights sends only the relevant finding data — URL, rule, evidence excerpts (including browser, performance and accessibility evidence when those checks ran) and page metadata, limited to {cfg.usage.maxAiInputChars.toLocaleString()} characters — to the provider YOU connected with your own key (OpenRouter or Google Gemini). Cookies and IP addresses are never included. Your API key itself is sent to the SiteInsights AI endpoint only so the server can place that one provider request, and is never stored.</li>
            <li>Crawled content is treated as untrusted data. Instructions hidden in a website&apos;s text are not followed.</li>
            <li>AI responses are checked against a strict schema. Invalid responses are retried a limited number of times and otherwise rejected — the deterministic findings remain available.</li>
            <li>AI explains and suggests; it never modifies your website and never claims that fixes have been applied.</li>
            <li>The provider used is shown on every AI result. Providers have their own data policies; the operator chooses which provider is enabled.</li>
          </ul>

          <h2 id="storage">Data storage</h2>
          <p>A verified account is required for every audit. Reports belong to that account and can also be read by verified members of a team with which the owner explicitly shares the audit. A copied report URL or legacy private-link key does not grant access on its own. Only the owner can change or re-run an audit. Your most recent audits are retained (up to {plans.free.historyLimit}); older audits are removed automatically when you start a new one. Production requires a persistent database. See the <Link href="/privacy">privacy policy</Link>.</p>

          <h2 id="limitations">Known limitations</h2>
          <ul>
            <li>Without browser rendering (or beyond its page limit), JavaScript is not executed, so content and links rendered only by client-side JavaScript are not seen.</li>
            <li>Performance is measured for the start page only, and lab values vary between runs.</li>
            <li>Automated accessibility testing cannot confirm WCAG conformance.</li>
            <li>Only the pages within the audit&apos;s page and depth limits are crawled, so &quot;orphan page&quot; findings are candidates that need confirmation. The report shows how many pages were scanned, skipped and failed.</li>
            <li>Pages behind logins, paywalls or bot protection cannot be analysed.</li>
            <li>External links that block automated requests are reported as unverified.</li>
            <li>Audits keep running in the background after you leave the progress page when background processing is configured on the server; otherwise they pause and resume when you return. Progress is saved either way.</li>
            <li>Results reflect the moment of the scan. Temporary outages can affect link results.</li>
          </ul>

          <h2 id="faq">FAQ</h2>
          <h3>Is there a free plan?</h3>
          <p>Yes — SiteInsights is completely free. Every feature is included and audits of up to {plans.free.maxPagesPerAudit} pages have no cost, no credits and no subscription. Technical safeguards (per-visitor rate windows and page caps) keep the service reliable for everyone.</p>
          <h3>Why is a link I know works marked &quot;unverified&quot;?</h3>
          <p>Some sites block automated requests or require a login. We report what we observed rather than guessing, and we never count these as broken.</p>
          <h3>Why did my scan fail?</h3>
          <p>Common causes: the domain does not resolve, the site blocks crawlers in robots.txt, the server refused every request, or the address points to a private network.</p>
          <h3>Can I scan a site on localhost or my intranet?</h3>
          <p>No. For security, only public internet addresses can be scanned.</p>
          <h3>How do I block the SiteInsights crawler?</h3>
          <p>Add <code>User-agent: SiteLensAI</code> followed by <code>Disallow: /</code> to your robots.txt. This compatibility token is intentionally unchanged by the SiteInsights rebrand, so existing exclusions still work.</p>
        </article>
      </div>
    </div>
  );
}
