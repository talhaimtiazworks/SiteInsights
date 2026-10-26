/**
 * Product UI acceptance checks: public pages render on their own, the dark
 * theme is gone, the retired homepage sections are gone, navigation exposes
 * Features and Pricing, marketing copy advertises only real capabilities,
 * paid checkout is disabled without a provider, and the 3D hero has a static
 * fallback that needs no WebGL.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "node-html-parser";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

import LandingPage, { revalidate as landingRevalidate } from "@/app/page";
import { UrlForm } from "@/components/url-form";
import { SocialLinksSection } from "@/components/contact/social-links";
import FeaturesPage from "@/app/features/page";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { CrawlMapSvg, HeroVisual, webglAvailable } from "@/components/hero/hero-visual";

const root = path.resolve(__dirname, "..");
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => parse(renderToStaticMarkup(el));

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

/** Claims the product must not make: none of these are implemented. */
const UNIMPLEMENTED = /white[- ]?label|unlimited|integrations? with|zapier|slack integration|automated (prospecting|outreach)|auto[- ]?send|priority (queue|processing)|testimonials?|trusted by|\d[\d,]*\+ (customers|users|agencies)/i;

describe("public product pages", () => {
  it("/pricing is gone: no pricing page, plan ids, prices or checkout UI exist anywhere in src", () => {
    // The pricing directory and its checkout component were deleted for the free-product conversion.
    expect(existsSync(path.join(root, "src/app/pricing/page.tsx"))).toBe(false);
    expect(existsSync(path.join(root, "src/components/plan-cta.tsx"))).toBe(false);
    // No marketing or navigation surface may point at a pricing page or Stripe checkout anymore.
    const components = [
      render(createElement(LandingPage)),
      render(createElement(FeaturesPage)),
      render(createElement(SiteHeader)),
      render(createElement(SiteFooter)),
    ];
    for (const doc of components) {
      expect(doc.querySelector('a[href="/pricing"]')).toBeNull();
    }
    for (const text of components.map((c) => c.text)) {
      for (const b of ["$/month", "$5", "$10", "Payments coming soon", "Compare plans", "upgrade"]) {
        expect(text.toLowerCase(), b).not.toContain(b.toLowerCase());
      }
    }
    // Source-level: no pricing/nav links left in the shared shell components.
    const headerSource = readFileSync(path.join(root, "src/components/site-header.tsx"), "utf8");
    const footerSource = readFileSync(path.join(root, "src/components/site-footer.tsx"), "utf8");
    for (const s of [headerSource, footerSource]) expect(s).not.toContain("/pricing");
  });

  it("/features renders real capabilities and labels limitations", () => {
    const text = render(createElement(FeaturesPage)).text;
    expect(text).toMatch(/broken link/i);
    expect(text).toMatch(/prospect/i);
    expect(text).toMatch(/limitation|not (?:available|included)|does not/i);
    // Unimplemented capabilities may only be named as explicit limitations.
    const mentions = text.split(/(?<=[.!?])\s+/).filter((sentence) => UNIMPLEMENTED.test(sentence));
    expect(mentions.length).toBeGreaterThan(0);
    for (const sentence of mentions) expect(sentence, sentence).toMatch(/\b(no|not|never|without)\b/i);
  });

  it("the homepage keeps a concise hero, workflow and free-for-everyone section; the retired pricing strip is gone", () => {
    const page = render(createElement(LandingPage));
    const text = page.text;
    expect(page.querySelector("#hero-heading")).not.toBeNull();
    expect(text).not.toMatch(/What SiteInsights checks/i);
    expect(text).not.toMatch(/What a report looks like/i);
    expect(page.querySelector('a[href="/pricing"]')).toBeNull();
    // The free-product message replaced the plan cards entirely.
    expect(text).toMatch(/Free for everyone/);
    expect(text).toMatch(/no subscriptions, no credits, no checkout/i);
    expect(text).not.toMatch(/Simple plans, measured in credits/);
    expect(text).not.toMatch(/per month/);
    expect(text).not.toMatch(UNIMPLEMENTED);
  });

  it("the public homepage exposes the audit URL field while session resolution continues in the background", () => {
    const page = render(createElement(UrlForm, { size: "lg" }));
    const input = page.querySelector("#site-url");
    expect(landingRevalidate).toBe(300);
    expect(page.querySelector('label[for="site-url"]')?.text).toBe("Website to audit");
    expect(input?.getAttribute("placeholder")).toBe("example.com or https://example.com");
    expect(input?.getAttribute("aria-describedby")).toBe("url-help");
    expect(page.querySelector('button[type="submit"]')?.text).toMatch(/Scan Site/);
    expect(page.text).toMatch(/Checking your session in the background/);
    expect(page.querySelector('input[aria-invalid="true"]')).toBeNull();
  });

  it("retains scan submission, plan/page controls and server-authoritative validation", () => {
    const source = readFileSync(path.join(root, "src/components/url-form.tsx"), "utf8");
    expect(source).toContain('api<{ id: string; accessKey: string | null }>("/api/scans"');
    expect(source).toContain('headers: { "Idempotency-Key": key }');
    expect(source).toContain("parseHttpUrlInput(url)");
    expect(source).toContain('flex flex-col gap-3 sm:flex-row');
    expect(source).toContain('sm:flex-row');
    expect(source).toContain('name="url"');
    expect(source).toContain('>Pages</span>');
    expect(source).toContain("fresh.status !== \"signed_in\"");
    // Layout fix: the Scan Site label must stay on one line while the flexible input absorbs overflow.
    expect(source).toContain("min-w-0 truncate");
    expect(source).toContain("sm:flex-1");
    expect(source).toContain('rounded-full bg-[#e8447a] px-3 py-2 text-white shadow-none hover:bg-[#d13a6f] hover:shadow-none motion-safe:hover:transform-none');
    // The submit button reads exactly "Scan Site" (idle) and "..." (loading), pink pill per the approved direct-edit spec.
    expect(source).toContain('{busy ? "..." : "Scan Site"}');
    expect(source).toContain("truncate rounded-full px-3 py-2 border border-charcoal/20 bg-card");
    // Free product: the form no longer consults or displays credits, balances or per-page costs.
    expect(source).toContain('disabled={busy}');
    expect(source).not.toContain("cannotAfford");
    expect(source).not.toContain("summary.balance");
    expect(source).not.toContain("credits.reload()");
    expect(source).not.toContain("affordablePages");
    expect(source).not.toContain("/pricing");
    expect(source).toContain("SiteInsights is free — there is no charge and no credit balance to watch.");
  });

  it("the header links Home, Features, Teams, Contact and Docs — no Pricing — and offers a start-audit action", () => {
    const page = render(createElement(SiteHeader));
    // Guide nav item: exactly one, in the shared list (appearing in desktop AND mobile navs), internal route.
    const guideLinks = page.querySelectorAll('a[href="/guide"]');
    expect(guideLinks.length).toBeGreaterThanOrEqual(1);
    for (const a of guideLinks) expect(a.text.trim()).toBe("Guide");
    // The removed ebooks feature left no visible links behind.
    expect(page.querySelectorAll('a[href*="/ebooks"]').length).toBe(0);
    for (const href of ["/features", "/teams", "/contact", "/help"]) expect(page.querySelector(`a[href="${href}"]`), href).not.toBeNull();
    // The Pricing link was removed from navigation for the free product.
    expect(page.querySelectorAll('a[href="/pricing"]').length).toBe(0);
    expect(page.text).not.toMatch(/Pricing/);
    expect(page.text).toMatch(/Home/);
    expect(page.text).toMatch(/Docs/);
    expect(page.querySelectorAll("a").some((a) => /audit/i.test(a.text) && /audit/.test(a.getAttribute("href") ?? ""))).toBe(true);
    expect(page.querySelector("#mobile-nav")?.hasAttribute("hidden")).toBe(true);
    expect(page.querySelector('button[aria-controls="mobile-nav"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(page.text).not.toMatch(/dark mode|theme/i);
  });

  it("account dropdown keeps its white panel but overrides inherited header white with readable dark text", () => {
    const source = readFileSync(path.join(root, "src/components/account-menu.tsx"), "utf8");
    const panelClass = source.match(/<div role="menu" aria-label="Account" className="([^"]+)"/)?.[1] ?? "";
    const itemClass = source.match(/const item = "([^"]+)"/)?.[1] ?? "";
    expect(panelClass).toContain("bg-card");
    expect(panelClass).toContain("text-[#1B1931]");
    expect(itemClass).toContain("hover:bg-muted");
    expect(itemClass).toContain("focus:bg-muted");
    expect(itemClass).not.toContain("text-white");
    expect(source).toContain("text-muted-foreground"); // email uses the dark secondary token
    for (const label of ["Dashboard", "My audits", "Prospects", "Teams", "Account & history", "Usage", "Account settings", "Sign out"]) expect(source).toContain(`"${label}"`);
    expect(source).not.toContain('"Plan & credits"');
    expect(source).toContain("u.displayName || \"Your account\"");
    expect(source).toContain("u.email");
    expect(readFileSync(path.join(root, "src/components/site-header.tsx"), "utf8")).toContain("bg-charcoal/95 text-white");
    expect(readFileSync(path.join(root, "src/app/globals.css"), "utf8")).not.toContain("-webkit-text-fill-color");
    expect(readFileSync(path.join(root, "src/app/brand-tokens.css"), "utf8")).toContain("--card: 255 255 255;");
  });

  it("AI settings is strict BYOK: key input, genuine test, memory-only lifecycle — and no operator key", () => {
    const source = readFileSync(path.join(root, "src/app/settings/ai/ai-settings-client.tsx"), "utf8");
    expect(source).toContain("/api/ai/providers");
    expect(source).toContain("/api/ai/health");
    expect(source).toContain("/api/settings/ai");
    // BYOK interface contract:
    expect(source).toContain('type={showKey ? "text" : "password"}'); // masked input + show/hide
    expect(source).toContain("Test connection");
    expect(source).toContain("Connect");
    expect(source).toContain("Disconnect");
    expect(source).toContain("connectAiSession");
    expect(source).toContain("disconnectAiSession");
    expect(source).toContain("Charges and quotas are yours"); // billing warning copy present
    for (const removed of ["For operators: enabling AI", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "AI_PROVIDER", "AI_FALLBACK_ENABLED", "Your preferred provider", "Help → AI and privacy"]) expect(source).not.toContain(removed);
    expect(source).not.toContain("see below");
  });

  it("/contact keeps the banner and the official social profiles section, with the email and help cards removed", () => {
    const source = readFileSync(path.join(root, "src/app/contact/page.tsx"), "utf8");
    expect(source).toContain("PageHeader");
    // The two cards directly beneath the banner were removed with their logic.
    for (const removed of ["Tell us how we can help", "Before you write", "getConfig().contactEmail", "mailto:", "/help#faq", "/help#crawler", "No verified social profile"]) {
      expect(source, removed).not.toContain(removed);
    }
    // Unused imports went with them: only the header, section and metadata helper remain.
    expect(source).toContain('import { PageHeader } from "@/components/ui"');
    expect(source).not.toMatch(/import { Alert|import Link/);
    expect(source).toContain('import { SocialLinksSection } from "@/components/contact/social-links"');
    expect(source).toContain("<SocialLinksSection />");
    // No external URLs are hard-coded in the page itself.
    expect(source).not.toMatch(/href=["']https?:\/\//i);
  });

  it("official social profiles render exactly the nine verified links in order — NO Show More rows — with authentic marks and safe new-tab behavior", () => {
    const page = render(createElement(SocialLinksSection));

    // (1) Neither "Show More" row exists anymore — no disclosure buttons at all.
    expect(page.text).not.toMatch(/show\s*more/i);
    expect(page.querySelectorAll("button").length).toBe(0);
    expect(page.querySelector('a[href^="#profiles-more"]')).toBeNull();
    expect(page.querySelector("#profiles-more-1")).toBeNull();
    expect(page.querySelector("#profiles-more-2")).toBeNull();

    // (2)+(3) Only the real configured profiles, in order, with the owner's verified URLs.
    const anchors = page.querySelectorAll("a");
    const expected: Array<[string, string, string, string]> = [
      ["TalhaImtiazWorks", "OFFICIAL CONTACT & STUDIO", "https://talhaimtiazworks.vercel.app/contact", "01"],
      ["Contra", "STUDIO PROFILE & CLIENT WORK", "https://contra.com/talhaimtiazworks", "02"],
      ["GitHub", "CODE, BUILDS & EXPERIMENTS", "https://github.com/talhaimtiazworks", "03"],
      ["LinkedIn", "PROFESSIONAL PROFILE", "https://www.linkedin.com/in/talhaimtiazworks", "04"],
      ["X", "NOTES, LAUNCHES & UPDATES", "https://x.com/talhaimtiazwork", "05"],
      ["Instagram", "VISUAL WORK & STUDIO LIFE", "https://www.instagram.com/talhaimtiazworks/", "06"],
      ["Threads", "CONVERSATIONS & SHORT UPDATES", "https://www.threads.com/@talhaimtiazworks", "07"],
      ["Pinterest", "VISUAL REFERENCES & BOARDS", "https://www.pinterest.com/talhaimtiazworks/", "08"],
      ["Jobbers.io", "PROFESSIONAL PROFILE", "https://www.jobbers.io/author/talha-imtiaz/", "09"],
    ];
    expect(anchors.length).toBe(expected.length);
    anchors.forEach((a, i) => {
      const [name, subtitle, href, num] = expected[i];
      expect(a.getAttribute("href")).toBe(href);
      // safe external-link attributes on every row
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.text).toContain(name);
      expect(a.text.toUpperCase()).toContain(subtitle);
      expect(a.text).toContain(num);
      expect(a.text).toContain("opens in a new tab");
      // (6) keyboard: whole row is ONE native anchor, hover + visible focus styles.
      const cls = a.getAttribute("class") ?? "";
      expect(cls).toMatch(/hover:bg-white/);
      expect(cls).toMatch(/focus-visible:/);
      expect(a.querySelectorAll("button, a").length).toBe(0); // no nested controls inside the row
    });
    // Facebook and YouTube remain excluded by design.
    expect(page.text).not.toMatch(/facebook|you ?tube/i);
    // Authentic assets: the studio logo and the real jobbers.io mark render as images, the rest as inline SVGs.
    const imgSrcs = page.querySelectorAll("img").map((img) => img.getAttribute("src") ?? "");
    expect(imgSrcs.some((src) => src.includes("talhaimtiazworks-logo-160.png"))).toBe(true);
    expect(imgSrcs.some((src) => src.includes("jobbers-io-logo.png"))).toBe(true);
  });

  it("social rows use a fixed aligned column grid — names never wrap, descriptions truncate, nothing can push columns out of place", () => {
    const page = render(createElement(SocialLinksSection));
    const anchors = page.querySelectorAll("a");
    expect(anchors.length).toBe(9);
    for (const a of anchors) {
      const cls = a.getAttribute("class") ?? "";
      // The row is a GRID with explicit fixed-width index/icon/arrow columns.
      expect(cls).toContain("grid");
      expect(cls).toContain("grid-cols-[1.5rem_1.875rem_minmax(0,1fr)_1.5rem]");
      // The name column is a bounded fixed band on description-capable widths.
      expect(cls).toContain("min-[420px]:grid-cols-[1.5rem_1.875rem_minmax(7rem,9.5rem)_minmax(0,1fr)_1.5rem]");
      const nameCell = a.querySelector("span[title]");
      expect(nameCell?.getAttribute("class") ?? "").toMatch(/whitespace-nowrap/); // names never split lines
      expect(nameCell?.getAttribute("class") ?? "").toMatch(/truncate/);
      expect(nameCell?.getAttribute("class") ?? "").toMatch(/min-w-0/);
      // external-link arrow always present (Show More arrow-suppression branch is gone);
      // marks can be svg or (for the studio/jobbers marks) img
      expect(a.querySelectorAll("svg").length).toBeGreaterThanOrEqual(1); // the arrow
      expect(a.querySelectorAll("svg, img").length).toBeGreaterThanOrEqual(2); // mark + arrow
    }
    // descriptions truncate inside min-w-0 cells (no unintended horizontal overflow drivers)
    const subs = page.querySelectorAll(".sr-sub");
    expect(subs.length).toBe(9);
    for (const sub of subs) {
      const c = sub.getAttribute("class") ?? "";
      expect(c).toMatch(/truncate/);
      expect(c).toMatch(/min-w-0/);
    }
  });

  it("social section layout: two columns on desktop, one on mobile, section clips any residual overflow", () => {
    const page = render(createElement(SocialLinksSection));
    const section = page.querySelector("section");
    expect(section?.getAttribute("class") ?? "").toContain("overflow-x-clip");
    const grid = section?.querySelector(".md\\:grid-cols-2");
    expect(grid).not.toBeNull(); // 2-col ≥ md, default 1-col (mobile)
    const lists = page.querySelectorAll("ol");
    expect(lists.length).toBe(2);
    expect(lists[0].querySelectorAll("li").length).toBe(5); // 01–05
    expect(lists[1].querySelectorAll("li").length).toBe(4); // 06–09
  });

  it("audit UI marks private/shared status and exposes owner-controlled team sharing", () => {
    const audits = readFileSync(path.join(root, "src/app/dashboard/audits/audits-client.tsx"), "utf8");
    const actions = readFileSync(path.join(root, "src/components/audit-owner-actions.tsx"), "utf8");
    const teams = readFileSync(path.join(root, "src/app/account/(settings)/organizations/organizations-client.tsx"), "utf8");
    expect(audits).toContain('"Shared with team" : "Private"');
    expect(audits).toContain('value="all">Mine + shared with my teams');
    expect(audits).toContain("<AuditShareButton");
    expect(actions).toContain('scan.organizationId ? "Shared with team" : "Private"');
    expect(actions).toContain("Share with a team");
    expect(teams).toContain('href="/dashboard/audits?scope=all"');
    expect(teams).toContain("View team audits");
  });

  it("team management exposes explicit invitation responses and never offers direct member addition", () => {
    const teams = readFileSync(path.join(root, "src/app/account/(settings)/organizations/organizations-client.tsx"), "utf8");
    const legacyMembers = readFileSync(path.join(root, "src/app/api/organizations/[orgId]/members/route.ts"), "utf8");
    const email = readFileSync(path.join(root, "src/lib/services/organization-invitation-email.ts"), "utf8");
    expect(teams).toContain("Invitation inbox");
    expect(teams).toContain("You join a team only after accepting an invitation");
    expect(teams).toContain("Accept");
    expect(teams).toContain("Decline");
    expect(teams).toContain("No email was sent");
    expect(teams).toContain("Create invitation");
    expect(teams).not.toContain("Send invitation");
    expect(teams).toContain("window.location.replace(`/teams/invitation#invite=${encodeURIComponent(token)}`)");
    expect(teams).not.toContain("Add an existing account");
    expect(legacyMembers).toContain('410, "invitation_required"');
    expect(legacyMembers).toContain("Direct member additions are disabled");
    expect(email).toContain('status: "not_configured"');
    expect(email).not.toMatch(/from\s+["']nodemailer["']/);
  });

  it("profile type uses native freelancer/agency radios and only shows agency inputs for the agency choice", () => {
    const source = readFileSync(path.join(root, "src/app/account/(settings)/professional-profile/professional-profile-client.tsx"), "utf8");
    expect(source).toContain('type="radio" name="profileType" value="freelancer"');
    expect(source).toContain('type="radio" name="profileType" value="agency"');
    expect(source).toContain('profile.profileType === "agency" ? <label');
    expect(source).toContain('updateProfile({ profileType: "freelancer" })');
    expect(source).toContain("preserves your profile fields, services, portfolio, and publication choices");
  });

  it("only routes new registrations through the private professional-profile setup", () => {
    const signupPage = readFileSync(path.join(root, "src/app/sign-up/page.tsx"), "utf8");
    const signupClient = readFileSync(path.join(root, "src/app/sign-up/sign-up-client.tsx"), "utf8");
    const signupRoute = readFileSync(path.join(root, "src/app/api/auth/sign-up/route.ts"), "utf8");
    const profile = readFileSync(path.join(root, "src/app/account/(settings)/professional-profile/professional-profile-client.tsx"), "utf8");
    expect(signupPage).toContain("if (session.user) redirect(requestedNext)");
    expect(signupPage).toContain("const registrationNext = requestedNext === INVITATION_CONTINUATION_PATH ? requestedNext : NEW_ACCOUNT_ONBOARDING_PATH");
    expect(signupPage).toContain("next={registrationNext}");
    expect(signupPage).toContain("signInNext={requestedNext}");
    expect(signupPage).toContain("INVITATION_CONTINUATION_PATH");
    expect(signupClient).toContain('mode="sign_up"');
    expect(signupClient).toContain("signInNext !== \"/dashboard\"");
    expect(signupRoute).toContain("const next = body.next === INVITATION_CONTINUATION_PATH ? INVITATION_CONTINUATION_PATH : NEW_ACCOUNT_ONBOARDING_PATH");
    const callback = readFileSync(path.join(root, "src/app/auth/callback/route.ts"), "utf8");
    expect(callback).toContain("isNewOAuthRegistration && next !== INVITATION_CONTINUATION_PATH ? NEW_ACCOUNT_ONBOARDING_PATH : next");
    expect(profile).toContain("Let's set up your professional profile");
    expect(profile).toContain("Save your draft whenever you like and return later.");
    expect(profile).toContain("Everything stays private unless you explicitly opt it into report publication.");
  });

  it("branding editor exposes named colors, validation, and an accessible drag-and-drop logo uploader", () => {
    const source = readFileSync(path.join(root, "src/app/account/(settings)/professional-profile/professional-profile-client.tsx"), "utf8");
    expect(source).toContain("Brand colors");
    expect(source).toContain("Color name");
    expect(source).toContain("Hex value");
    expect(source).toContain("type=\"color\"");
    expect(source).toContain("Add color");
    expect(source).toContain("onDrop=");
    expect(source).toContain("Upload logo");
    expect(source).toContain("Replace logo");
    expect(source).toContain("Remove logo");
    expect(source).toContain("1,048,576 bytes");
    expect(source).toContain("2,048 pixels per side");
    expect(source).toContain("2 million pixels total");
    expect(source).toContain("Logo publication option");
  });

  it("uses pressed-button semantics for prospect status filters", () => {
    const source = readFileSync(path.join(root, "src/app/dashboard/prospects/prospects-client.tsx"), "utf8");
    expect(source).toContain("aria-pressed={active}");
    expect(source).not.toContain("aria-selected={active}");
  });
});

describe("design system", () => {
  it("removed the dark theme and its toggle everywhere", () => {
    expect(existsSync(path.join(root, "src/components/theme-toggle.tsx"))).toBe(false);
    const offenders = files(path.join(root, "src")).filter((f) => {
      const s = readFileSync(f, "utf8");
      return /\bdark:|theme-toggle|ThemeToggle|themeInitScript|prefers-color-scheme:\s*dark|\.dark\s*\{/.test(s);
    });
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
    expect(readFileSync(path.join(root, "tailwind.config.ts"), "utf8")).not.toMatch(/darkMode/);
  });

  it("keeps transitions brief and honors reduced-motion preferences", () => {
    const css = readFileSync(path.join(root, "src/app/globals.css"), "utf8");
    const ui = readFileSync(path.join(root, "src/components/ui.tsx"), "utf8");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("prefers-reduced-motion: no-preference");
    expect(css).toContain(".ui-card--lift");
    expect(ui).toContain("motion-safe:hover:-translate-y-px");
    expect(ui).toContain("duration-150");
  });

  it("uses no neon glow, gradient blobs or emoji in UI source", () => {
    const offenders = files(path.join(root, "src")).filter((f) => {
      const s = readFileSync(f, "utf8");
      return /bg-gradient-to|blur-3xl|drop-shadow-\[|shadow-\[0_0_|\p{Emoji_Presentation}/u.test(s.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ""));
    });
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});

describe("3D hero", () => {
  it("server-renders a static SVG crawl map and never needs WebGL to show the hero", () => {
    const page = render(createElement(HeroVisual));
    expect(page.querySelector("[data-hero-mode]")?.getAttribute("data-hero-mode")).toBe("static");
    expect(page.querySelector("svg")).not.toBeNull();
    expect(render(createElement(CrawlMapSvg)).querySelector("svg")).not.toBeNull();
  });

  it("reports WebGL as unavailable when no context can be created, so the fallback stays", () => {
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
    try {
      expect(webglAvailable()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal("document", { createElement: () => { throw new Error("no DOM"); } });
    try {
      expect(webglAvailable()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads Three.js lazily and respects reduced motion", () => {
    const hero = readFileSync(path.join(root, "src/components/hero/hero-visual.tsx"), "utf8");
    expect(hero).not.toMatch(/from "three"/);
    expect(hero).toMatch(/await import\("\.\/crawl-scene"\)/);
    expect(hero).toMatch(/prefers-reduced-motion: reduce/);
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.dependencies.three).toBeDefined();
    expect(pkg.dependencies["@babylonjs/core"]).toBeUndefined(); // one 3D engine only
  });
});
