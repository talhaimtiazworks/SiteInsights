import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script helpers without type declarations
import { describeChanges, mergeAllowList, normalizeOrigin, mailjetSmtpPatch, projectRef, redirectUrlsFor, templatePatch } from "../scripts/supabase/auth-config-lib.mjs";

import { MAILJET_TEST_USER as USER, MAILJET_TEST_PASS as PASS, MAILJET_TEST_FROM as FROM, MAILJET_TEST_ENV } from "./fixtures/mailjet-smtp";

const REF = "qrstuvwxyz0123456789";

describe("Supabase auth config helpers", () => {
  it("derives the project ref", () => {
    expect(projectRef({ NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` })).toBe(REF);
    expect(projectRef({ SUPABASE_PROJECT_REF: REF })).toBe(REF);
    expect(() => projectRef({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" })).toThrow();
    expect(() => projectRef({ SUPABASE_PROJECT_REF: "nope" })).toThrow();
  });

  it("only accepts a public https origin as Site URL", () => {
    expect(normalizeOrigin("https://siteinsight.xyz/")).toBe("https://siteinsight.xyz");
    for (const bad of ["http://siteinsight.xyz", "https://localhost:3000", "https://127.0.0.1", "https://user:secret@siteinsight.xyz"]) expect(() => normalizeOrigin(bad)).toThrow();
  });

  it("merges redirect URLs without dropping existing entries", () => {
    const add = redirectUrlsFor("https://siteinsight.xyz", { previewPattern: "https://sitelens-ai-*-team.vercel.app/**" });
    expect(add).toEqual(["https://siteinsight.xyz/**", "https://sitelens-ai-*-team.vercel.app/**", "http://localhost:3000/**"]);
    expect(mergeAllowList("https://other.example/**, http://localhost:3000/**", add)).toBe("https://other.example/**,http://localhost:3000/**,https://siteinsight.xyz/**,https://sitelens-ai-*-team.vercel.app/**");
    expect(mergeAllowList(undefined, ["a"])).toBe("a");
    expect(redirectUrlsFor("https://x.dev", { localhost: false })).toEqual(["https://x.dev/**"]);
  });

  it("builds template fields with the Management API names; notifications are opt-in", () => {
    const t = { confirmation: { subject: "S1", html: "<p>1</p>" }, password_changed_notification: { subject: "S2", html: "<p>2</p>" } };
    expect(templatePatch(t)).toEqual({ mailer_subjects_confirmation: "S1", mailer_templates_confirmation_content: "<p>1</p>" });
    expect(templatePatch(t, { notifications: true })).toMatchObject({
      mailer_subjects_password_changed_notification: "S2",
      mailer_templates_password_changed_notification_content: "<p>2</p>",
      mailer_notifications_password_changed_enabled: true,
    });
  });

  it("Mailjet SMTP keeps API credentials separate from sender and never prints them", () => {
    expect(() => mailjetSmtpPatch({})).toThrow(/Missing server-side email settings/);
    const patch = mailjetSmtpPatch(MAILJET_TEST_ENV);
    expect(patch).toEqual({ smtp_host: "in-v3.mailjet.com", smtp_port: "587", smtp_user: USER, smtp_pass: PASS, smtp_admin_email: FROM, smtp_sender_name: "SiteInsights" });
    const text = describeChanges({}, patch).join("\n");
    for (const value of [USER, PASS, FROM]) expect(text).not.toContain(value);
    expect(text).toContain("smtp_pass = (secret from environment)");
  });
});

describe("configure-auth.mjs against a local Management API stub", () => {
  let server: Server;
  let base = "";
  const requests: Array<{ method: string; url: string; auth: string; body: Record<string, unknown> | null }> = [];
  let config: Record<string, unknown> = { site_url: "http://localhost:3000", uri_allow_list: "https://sitelens-ai.vercel.app/**,https://keep.example/**" };
  const body = (req: IncomingMessage) => new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const raw = await body(req);
      const parsed = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization ?? "", body: parsed });
      if (req.url !== `/v1/projects/${REF}/config/auth`) return void res.writeHead(404).end("{}");
      if (req.method === "PATCH") config = { ...config, ...parsed };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(config));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const run = (args: string[], extra: Record<string, string> = {}) =>
    promisify(execFile)(process.execPath, ["scripts/supabase/configure-auth.mjs", "--app-url", "https://siteinsight.xyz", ...args], {
      env: { NODE_ENV: "test", PATH: process.env.PATH, SUPABASE_ACCESS_TOKEN: "sbp_test_token_value", SUPABASE_PROJECT_REF: REF, CONFIGURE_AUTH_API_BASE: base, ...extra },
    });

  it("dry run reads but does not write", async () => {
    const { stdout } = await run(["--urls", "--templates"]);
    expect(stdout).toContain("dry run");
    expect(stdout).toContain('site_url = "https://siteinsight.xyz"');
    expect(stdout).toMatch(/mailer_templates_confirmation_content = \d+ chars of branded HTML/);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(requests[0].auth).toBe("Bearer sbp_test_token_value");
  });

  it("--apply sets Site URL, keeps existing redirect URLs and uploads templates", async () => {
    const { stdout } = await run(["--urls", "--templates", "--apply"]);
    expect(stdout).toContain("Saved and read back successfully.");
    const patch = requests.find((r) => r.method === "PATCH")!.body!;
    expect(patch.site_url).toBe("https://siteinsight.xyz");
    expect(patch.uri_allow_list).toBe("https://sitelens-ai.vercel.app/**,https://keep.example/**,https://siteinsight.xyz/**,http://localhost:3000/**");
    expect(String(patch.mailer_templates_recovery_content)).toContain("{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery");
    expect(patch).not.toHaveProperty("mailer_notifications_password_changed_enabled");
    expect(patch).not.toHaveProperty("smtp_pass");
  });

  it("--smtp sends only Mailjet settings, keeps all unrelated Auth settings, and never prints credentials", async () => {
    requests.length = 0;
    Object.assign(config, { mailer_autoconfirm: false, disable_signup: false, rate_limit_email_sent: 30, smtp_max_frequency: 60, external_google_enabled: true, security_captcha_enabled: true });
    const before = structuredClone(config);
    const { stdout, stderr } = await run(["--smtp", "--apply"], MAILJET_TEST_ENV);
    for (const secret of [USER, PASS, FROM, "sbp_test_token_value"]) expect(stdout + stderr).not.toContain(secret);
    const patch = requests.find((r) => r.method === "PATCH")!.body!;
    expect(patch).toEqual({ smtp_host: "in-v3.mailjet.com", smtp_port: "587", smtp_user: USER, smtp_pass: PASS, smtp_admin_email: FROM, smtp_sender_name: "SiteInsights" });
    for (const key of Object.keys(before).filter((key) => !key.startsWith("smtp_"))) expect(config[key]).toEqual(before[key]);
    expect(requests.map((r) => r.method)).toEqual(["GET", "PATCH", "GET"]);
    expect(stdout).toContain("No email was sent");
  });

  it("SMTP-only works without an app URL and preserves even the legacy working origin", async () => {
    requests.length = 0;
    config.site_url = "https://sitelens-ai.vercel.app";
    const { stdout } = await promisify(execFile)(process.execPath, ["scripts/supabase/configure-auth.mjs", "--smtp", "--apply"], {
      env: { NODE_ENV: "test", PATH: process.env.PATH, SUPABASE_ACCESS_TOKEN: "sbp_test_token_value", SUPABASE_PROJECT_REF: REF, CONFIGURE_AUTH_API_BASE: base, ...MAILJET_TEST_ENV },
    });
    expect(stdout).toContain("Saved and read back successfully");
    expect(config.site_url).toBe("https://sitelens-ai.vercel.app");
    expect(requests.find((r) => r.method === "PATCH")!.body).not.toHaveProperty("site_url");
  });

  it("validates missing SMTP fields before contacting even the local API", async () => {
    requests.length = 0;
    await expect(run(["--smtp", "--apply"])).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("refuses a local Site URL", async () => {
    await expect(promisify(execFile)(process.execPath, ["scripts/supabase/configure-auth.mjs", "--app-url", "http://localhost:3000", "--urls"], { env: { NODE_ENV: "test", PATH: process.env.PATH, SUPABASE_ACCESS_TOKEN: "x", SUPABASE_PROJECT_REF: REF, CONFIGURE_AUTH_API_BASE: base } })).rejects.toThrow();
  });
});
