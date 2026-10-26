import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = path.join(process.cwd(), "supabase/templates");
const meta = JSON.parse(readFileSync(path.join(dir, "subjects.json"), "utf8")) as { appUrl: string; year: number; subjects: Record<string, string> };
const keys = Object.keys(meta.subjects);
const read = (f: string) => readFileSync(path.join(dir, f), "utf8");

// Template variables documented at supabase.com/docs/guides/auth/auth-email-templates
const SUPABASE_VARS = new Set(["ConfirmationURL", "Token", "TokenHash", "SiteURL", "RedirectTo", "Data", "Email", "NewEmail", "OldEmail", "Phone", "OldPhone", "Provider", "FactorType"]);
const EXPECTED_TYPE: Record<string, string> = { confirmation: "email", recovery: "recovery", email_change: "email_change", magic_link: "magiclink", invite: "invite" };

describe("branded Supabase Auth email templates", () => {
  it("follow the configured Supabase Site URL and cover every auth email the app can trigger", () => {
    expect(meta.appUrl).toBe("{{ .SiteURL }}");
    for (const k of ["confirmation", "recovery", "email_change", "magic_link", "invite", "reauthentication"]) expect(keys).toContain(k);
    const files = readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, "")).sort();
    expect(files).toEqual([...keys].sort());
  });

  it("committed files match the generator output (no hand edits drift)", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "sl-email-"));
    try {
      execFileSync(process.execPath, ["scripts/email/build-templates.mjs", "--app-url", meta.appUrl, "--year", String(meta.year), "--out", tmp]);
      for (const k of keys) {
        expect(readFileSync(path.join(tmp, `${k}.html`), "utf8"), k).toBe(read(`${k}.html`));
        expect(readFileSync(path.join(tmp, "text", `${k}.txt`), "utf8"), k).toBe(read(`text/${k}.txt`));
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  for (const k of keys) {
    describe(k, () => {
      const html = read(`${k}.html`);
      const text = read(`text/${k}.txt`);

      it("has the product, parent attribution, heading, security note and configured website", () => {
        expect(html).toContain(">SiteInsights<br>");
        expect(html).toContain("/brand/talhaimtiazworks-logo-160.png");
        expect(html).toMatch(/<h1[^>]*>[^<]{4,}<\/h1>/);
        expect(html).toContain("Security note:");
        expect(html).toContain(`<a href="${meta.appUrl}"`);
        expect(html).toContain(`>${meta.appUrl}<`);
        expect(html).toContain("TalhaImtiazWorks");
        expect(html).toContain(`&#169; ${meta.year} TalhaImtiazWorks. SiteInsights is a TalhaImtiazWorks product.`);
        expect(text).toContain("A TalhaImtiazWorks Product");
        expect(html).toContain('name="viewport"');
        expect(html).toContain("@media only screen and (max-width: 600px)");
        expect(html).toContain(`<title>${meta.subjects[k]}</title>`);
      });

      it("links only to the configured site (never localhost) and never uses ConfirmationURL", () => {
        const hrefs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
        expect(hrefs.length).toBeGreaterThan(0);
        for (const h of hrefs) expect(h.startsWith(`${meta.appUrl}/`) || h === meta.appUrl, h).toBe(true);
        expect(html + text).not.toMatch(/localhost|127\.0\.0\.1|ConfirmationURL/);
        expect(html).not.toMatch(/<script|<link |@import|url\(/i);
      });

      if (EXPECTED_TYPE[k]) {
        it("action button and fallback link go to the click-to-confirm page with the token hash", () => {
          const link = `${meta.appUrl}/auth/confirm?token_hash={{ .TokenHash }}&type=${EXPECTED_TYPE[k]}&next={{ .RedirectTo }}`;
          expect(html.split(`href="${link}"`).length - 1).toBe(2); // button + fallback link
          expect(html).toContain(`>${link}</a>`);
          expect(html).toContain("Button not working?");
          expect(text).toContain(link);
        });
      }
      if (k === "reauthentication" || k === "magic_link") {
        it("shows the one-time code", () => {
          expect(html).toContain("{{ .Token }}");
          expect(text).toContain("{{ .Token }}");
        });
      }

      it("uses only Supabase template variables, with balanced actions", () => {
        const actions = [...(html + text).matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]);
        for (const a of actions) expect(SUPABASE_VARS.has(a.replace(/^\./, "")), a).toBe(true);
        expect((html.match(/\{\{/g) ?? []).length).toBe((html.match(/\}\}/g) ?? []).length);
        if (k !== "email_change") expect(html).not.toContain("NewEmail");
      });

      it("plain-text version carries the same message", () => {
        expect(text.startsWith("SiteInsights\n")).toBe(true);
        expect(text).toContain("Security note:");
        expect(text).toContain(meta.appUrl);
        expect(text).not.toMatch(/<[a-z]/i);
      });

      it("does not invent addresses, phone numbers or corporate status", () => {
        expect(html + text).not.toMatch(/\b(street|suite|inc\.|ltd|gmbh|llc|registered|\+\d{6,}|@sitelens)/i);
      });
    });
  }
});
