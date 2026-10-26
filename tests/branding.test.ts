import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "node-html-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAND, brandCopyright } from "@/lib/brand";
import { applicationStructuredData, metadataOrigin, publicPageMetadata, PUBLIC_PATHS } from "@/lib/config/metadata";
import { ROBOTS_USER_AGENT_TOKEN } from "@/lib/scanner/robots";
import { Logo, Wordmark } from "@/components/brand";
import { SiteFooter } from "@/components/site-footer";
import { SignInClient } from "@/app/sign-in/sign-in-client";
import { SignUpClient } from "@/app/sign-up/sign-up-client";
import manifest from "@/app/manifest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

const root = process.cwd();
const legacyOrigin = "https://sitelens-ai.vercel.app";
afterEach(() => vi.unstubAllEnvs());

function configuredOrigin(origin: string) {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", origin);
  vi.stubEnv("VERCEL_URL", "");
}

describe("SiteInsights product and parent identity", () => {
  it("uses the exact official brand hierarchy and copyright", () => {
    expect(BRAND).toMatchObject({ name: "SiteInsights", category: "AI-Powered Website Auditing", parent: "TalhaImtiazWorks", attribution: "A TalhaImtiazWorks Product", tagline: "Find website issues. Understand them. Fix them.", intendedOrigin: "https://siteinsight.xyz" });
    expect(brandCopyright(2026)).toBe("© 2026 TalhaImtiazWorks. SiteInsights is a TalhaImtiazWorks product.");
  });

  it("renders a single product wordmark and an accessible home link", () => {
    expect(parse(renderToStaticMarkup(createElement(Wordmark))).text).toBe(BRAND.name);
    const logo = parse(renderToStaticMarkup(createElement(Logo)));
    expect(logo.querySelector("a")?.getAttribute("aria-label")).toBeUndefined();
    expect(logo.querySelector("a")?.text.replace(/\s+/g, " ").trim()).toBe("SiteInsights by TalhaImtiazWorks home");
    expect(logo.querySelector("a")?.getAttribute("href")).toBe("/");
  });

  it("has product-first footer branding and text-only parent attribution", () => {
    const footer = parse(renderToStaticMarkup(createElement(SiteFooter)));
    expect(footer.text).toContain(BRAND.tagline);
    expect(footer.text).toContain(BRAND.attribution);
    expect(footer.text).toContain(brandCopyright());
    expect(footer.querySelector('a[href="/about"]')).not.toBeNull();
    expect(footer.text).not.toMatch(/SiteLens/);
  });

  it.each(["sign-in", "sign-up"])("applies the same discreet parent attribution to the %s form", (page) => {
    const providers = { enabled: true, email: true, google: false, github: false, saml: false, signupDisabled: false, unavailable: false };
    const form = page === "sign-in"
      ? createElement(SignInClient, { providers, next: "/dashboard", error: null, reason: null })
      : createElement(SignUpClient, { providers, next: "/dashboard" });
    const card = parse(renderToStaticMarkup(form));
    expect(card.text).toContain(BRAND.name);
    expect(card.text).toContain(BRAND.attribution);
    expect(card.querySelector("input[type=email]")).not.toBeNull();
    expect(card.text).not.toMatch(/SiteLens/);
  });

  it("keeps the existing crawler exclusion token, rather than bypassing old robots rules", () => {
    expect(ROBOTS_USER_AGENT_TOKEN).toBe("SiteLensAI");
  });
});

describe("domain-transition-safe metadata", () => {
  it("never forces the intended domain onto an unconfigured or legacy deployment", () => {
    expect(metadataOrigin({})).toBeUndefined();
    expect(metadataOrigin({ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: legacyOrigin })).toBe(legacyOrigin);
    expect(metadataOrigin({ NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "sitelens-ai.vercel.app" })).toBe(legacyOrigin);
    expect(metadataOrigin({ NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "sitelens-ai.vercel.app", VERCEL_URL: "preview.example.com" })).toBe("https://preview.example.com");
  });

  it.each([legacyOrigin, BRAND.intendedOrigin])("uses the configured %s for public canonical, social and sitemap links", (origin) => {
    configuredOrigin(origin);
    const metadata = publicPageMetadata("/help", "Help", "Documented checks");
    expect(metadata).toMatchObject({ alternates: { canonical: `${origin}/help` }, openGraph: { url: `${origin}/help`, siteName: BRAND.name } });
    expect(sitemap().map((item) => item.url)).toEqual(PUBLIC_PATHS.map((p) => new URL(p, origin).href));
    expect(robots().sitemap).toBe(`${origin}/sitemap.xml`);
    for (const item of sitemap()) expect(item.url).not.toMatch(/\/scans\/|\/account|\/api\//);
  });

  it("ships a dedicated 1200x630 Open Graph card for /guide with absolute URL, dimensions and alt", () => {
    // Regression guard for the user-reported Instagram preview defect: with no og:image,
    // platforms scraped the tiny in-page logo and stretch-cropped it into a blurry card.
    configuredOrigin(legacyOrigin);
    const g = publicPageMetadata("/guide", "Guide", "desc", {
      path: "/brand/siteinsight-og-1200x630.png", width: 1200, height: 630, alt: "A descriptive alt",
    });
    const ogImage = g.openGraph!.images as { url: string; width: number; height: number; alt: string; type: string }[];
    expect(ogImage).toHaveLength(1);
    expect(ogImage[0]).toMatchObject({
      url: `${legacyOrigin}/brand/siteinsight-og-1200x630.png`,
      secureUrl: `${legacyOrigin}/brand/siteinsight-og-1200x630.png`,
      width: 1200, height: 630, type: "image/png", alt: "A descriptive alt",
    });
    expect(g.twitter).toMatchObject({ card: "summary_large_image", images: [{ url: `${legacyOrigin}/brand/siteinsight-og-1200x630.png`, alt: "A descriptive alt" }] });
    expect((g.openGraph as { type?: string }).type).toBe("website");
    // Pages without a card keep emitting no conflicting duplicate image tags.
    const plain = publicPageMetadata("/help", "Help", "desc");
    expect(plain.openGraph!.images ?? null).toBeNull();
  });

  it("the referenced guide social-card asset exists on disk and really is a 1200x630 PNG", () => {
    const guideSource = readFileSync(path.join(process.cwd(), "src/app/guide/page.tsx"), "utf8");
    const m = guideSource.match(/path: "([^"]+)",\s*width: 1200,\s*height: 630/);
    expect(m, "guide page passes a 1200x630 card to publicPageMetadata").not.toBeNull();
    const buf = readFileSync(path.join(process.cwd(), "public", m![1]));
    expect(buf.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(buf.readUInt32BE(16)).toBe(1200); // IHDR width
    expect(buf.readUInt32BE(20)).toBe(630);  // IHDR height
    expect(buf.length).toBeLessThan(1024 * 1024); // crawler-friendly size
  });

  it("keeps SiteInsights in the homepage title even at the root layout segment", () => {
    const home = publicPageMetadata("/", BRAND.category, BRAND.description);
    expect(home.title).toEqual({ absolute: "SiteInsights — AI-Powered Website Auditing" });
    expect(home.openGraph).toMatchObject({ title: "SiteInsights — AI-Powered Website Auditing" });
  });

  it("describes a parent-created software product, not a new company", () => {
    const schema = applicationStructuredData(BRAND.intendedOrigin);
    expect(schema["@type"]).toBe("WebApplication");
    expect(schema.name).toBe(BRAND.name);
    expect(schema.creator).toEqual({ "@type": "Organization", name: BRAND.parent });
    expect(schema.publisher).toEqual(schema.creator);
  });
});

describe("brand asset completeness", () => {
  it("has valid manifest references with no old filenames", () => {
    const data = manifest();
    expect(data.name).toBe(BRAND.name);
    expect(data.short_name).toBe(BRAND.name);
    for (const icon of data.icons ?? []) {
      expect(existsSync(path.join(root, "public", icon.src))).toBe(true);
      expect(icon.src).not.toMatch(/sitelens/i);
    }
    for (const size of [192, 512]) {
      const png = readFileSync(path.join(root, `public/brand/icon-${size}.png`));
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
    }
  });

  it("ships synchronized SVG favicons, three ICO sizes and accessible social images", () => {
    const icon = readFileSync(path.join(root, "public/brand/siteinsight-icon.svg"), "utf8");
    expect(icon).toContain("<title>SiteInsights</title>");
    expect(readFileSync(path.join(root, "src/app/icon.svg"), "utf8")).toBe(icon);
    expect(readFileSync(path.join(root, "public/favicon.svg"), "utf8")).toBe(icon);
    const ico = readFileSync(path.join(root, "src/app/favicon.ico"));
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
    for (const name of ["opengraph-image", "twitter-image"]) {
      const png = readFileSync(path.join(root, `src/app/${name}.png`));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
      expect(readFileSync(path.join(root, `src/app/${name}.alt.txt`), "utf8")).toContain(BRAND.attribution);
    }
  });
});

describe("email domain cutover", () => {
  it.each([legacyOrigin, BRAND.intendedOrigin])("can generate explicit templates for %s without changing auth routes", (origin) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "siteinsight-email-"));
    try {
      execFileSync(process.execPath, ["scripts/email/build-templates.mjs", "--app-url", origin, "--year", "2026", "--out", dir]);
      const recovery = readFileSync(path.join(dir, "recovery.html"), "utf8");
      expect(recovery).toContain(`${origin}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next={{ .RedirectTo }}`);
      expect(recovery).toContain("TalhaImtiazWorks");
      expect(recovery).not.toContain(origin === legacyOrigin ? BRAND.intendedOrigin : legacyOrigin);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
