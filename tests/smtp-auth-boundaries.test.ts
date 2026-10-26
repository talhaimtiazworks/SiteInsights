/** Exercise real auth route/preflight/error code with only the Supabase SDK mocked. No mail is sent. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { __resetConfigForTests } from "@/lib/config/env";
import { __resetRateLimitsForTests } from "@/lib/http/rate-limit";

const sdk = vi.hoisted(() => ({ signUp: vi.fn(), signInWithPassword: vi.fn(), resetPasswordForEmail: vi.fn(), resend: vi.fn(), updateUser: vi.fn(), getClaims: vi.fn() }));
vi.mock("@/lib/auth/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth/server")>(),
  supabaseForRequest: () => ({ auth: sdk }),
  requireUser: async () => ({ id: "11111111-2222-4333-8444-555555555555", email: "current@example.test", isSso: false }),
}));
import { POST as signUp } from "@/app/api/auth/sign-up/route";
import { POST as signIn } from "@/app/api/auth/sign-in/route";
import { POST as forgot } from "@/app/api/auth/forgot-password/route";
import { POST as resend } from "@/app/api/auth/resend/route";
import { POST as changeEmail } from "@/app/api/account/email/route";

const ORIGIN = "https://sitelens-ai.vercel.app"; // Keep the working legacy deployment, not an assumed cutover.
const SAVED = { ...process.env };
import { MAILJET_TEST_USER as SMTP_USER, MAILJET_TEST_PASS as SMTP_PASS, MAILJET_TEST_FROM as EMAIL_FROM, MAILJET_TEST_ENV } from "./fixtures/mailjet-smtp";
const RAW = `raw-provider-secret SMTP_USER=${SMTP_USER} SMTP_PASS=${SMTP_PASS}`;
let logs: Array<{ mock: { calls: unknown[][] } }> = [];
let fetchSpy: MockInstance<typeof fetch>;
beforeEach(() => {
  process.env = { ...SAVED, NODE_ENV: "test", NEXT_PUBLIC_APP_URL: ORIGIN, NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic_fixture", DATABASE_URL: "", POSTGRES_URL: "", ...MAILJET_TEST_ENV };
  __resetConfigForTests(); __resetRateLimitsForTests();
  for (const method of Object.values(sdk)) method.mockReset();
  sdk.signUp.mockResolvedValue({ data: { session: null }, error: null });
  sdk.signInWithPassword.mockResolvedValue({ error: null });
  sdk.getClaims.mockResolvedValue({ data: { claims: null }, error: null });
  for (const method of [sdk.resetPasswordForEmail, sdk.resend, sdk.updateUser]) method.mockResolvedValue({ error: null });
  logs = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {})];
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network allowed in auth boundary tests"));
});
afterEach(() => { process.env = { ...SAVED }; __resetConfigForTests(); __resetRateLimitsForTests(); vi.restoreAllMocks(); });

async function call(handler: typeof forgot, route: string, body: unknown, headers: Record<string, string> = {}) {
  const req = new NextRequest(`${ORIGIN}${route}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin", "x-real-ip": "10.57.63.14", ...headers }, body: JSON.stringify(body) });
  const response = await handler(req, {});
  const text = await response.text();
  for (const secret of [SMTP_USER, SMTP_PASS, EMAIL_FROM, "raw-provider-secret"]) {
    expect(text).not.toContain(secret);
    expect(JSON.stringify(logs.map((spy) => spy.mock.calls))).not.toContain(secret);
  }
  return { response, body: JSON.parse(text) };
}

describe("auth still uses Supabase rather than a second Next.js sender", () => {
  it("sign-up calls Supabase once with the same recipient, metadata and callback", async () => {
    const result = await call(signUp, "/api/auth/sign-up", { email: "Person@Example.test", password: "user-password-123", displayName: "Fixture", next: "/dashboard/audits" });
    expect(result.response.status).toBe(200);
    expect(result.body.data).toEqual({ status: "confirmation_required", email: "person@example.test" });
    expect(sdk.signUp).toHaveBeenCalledExactlyOnceWith({ email: "person@example.test", password: "user-password-123", options: { emailRedirectTo: `${ORIGIN}/auth/callback?next=%2Faccount%2Fprofessional-profile`, data: { full_name: "Fixture" } } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends an immediately signed-in email registration to professional-profile", async () => {
    sdk.signUp.mockResolvedValue({ data: { session: { access_token: "fixture", refresh_token: "fixture" } }, error: null });
    sdk.getClaims.mockResolvedValue({ data: { claims: { sub: "11111111-2222-4333-8444-555555555555", email: "person@example.test", user_metadata: { full_name: "Fixture" } } }, error: null });
    const result = await call(signUp, "/api/auth/sign-up", { email: "person@example.test", password: "user-password-123", next: "/dashboard/audits" });
    expect(result.response.status).toBe(200);
    expect(result.body.data).toEqual({ status: "signed_in", next: "/account/professional-profile" });
    expect(sdk.signUp.mock.calls[0][0].options.emailRedirectTo).toBe(`${ORIGIN}/auth/callback?next=%2Faccount%2Fprofessional-profile`);
  });

  it("existing email sign-in retains its requested safe destination", async () => {
    const result = await call(signIn, "/api/auth/sign-in", { email: "person@example.test", password: "user-password-123", next: "/dashboard/audits" });
    expect(result.response.status).toBe(200);
    expect(result.body.data).toEqual({ status: "signed_in", next: "/dashboard/audits" });
    expect(sdk.signInWithPassword).toHaveBeenCalledExactlyOnceWith({ email: "person@example.test", password: "user-password-123" });
  });

  it("does not disable or replace hosted Auth if Vercel has no SMTP variables", async () => {
    for (const name of ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "EMAIL_FROM"]) delete process.env[name];
    const result = await call(signUp, "/api/auth/sign-up", { email: "person@example.test", password: "user-password-123" });
    expect(result.response.status).toBe(200); expect(sdk.signUp).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forgot password preserves the target reset path and acknowledges a request, not delivery", async () => {
    const { response, body } = await call(forgot, "/api/auth/forgot-password", { email: "person@example.test" });
    expect(response.status).toBe(200); expect(body.data).toEqual({ sent: true, delivery: "unverified" });
    expect(sdk.resetPasswordForEmail).toHaveBeenCalledExactlyOnceWith("person@example.test", { redirectTo: `${ORIGIN}/auth/callback?next=%2Faccount%2Freset-password` });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resend preserves signup type, recipient and safe destination", async () => {
    const result = await call(resend, "/api/auth/resend", { email: "person@example.test", next: "/dashboard/audits" });
    expect(result.response.status).toBe(200); expect(result.body.data).toEqual({ sent: true, delivery: "unverified" });
    expect(sdk.resend).toHaveBeenCalledExactlyOnceWith({ type: "signup", email: "person@example.test", options: { emailRedirectTo: `${ORIGIN}/auth/callback?next=%2Fdashboard%2Faudits` } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("secure email change remains owned by Supabase, including its existing recipient policy", async () => {
    const result = await call(changeEmail, "/api/account/email", { email: "new@example.test" });
    expect(result.response.status).toBe(200); expect(result.body.data).toEqual({ pending: true });
    expect(sdk.updateUser).toHaveBeenCalledExactlyOnceWith({ email: "new@example.test" }, { emailRedirectTo: `${ORIGIN}/auth/callback?next=%2Faccount%2Fprofile%3Femail%3Dchanged` });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("safe provider failures, anti-enumeration and anti-abuse", () => {
  it.each(["forgot-password", "resend"])("%s gives the same acknowledgement for unknown/undeliverable accounts and normal requests", async (which) => {
    const method = which === "resend" ? sdk.resend : sdk.resetPasswordForEmail;
    const handler = which === "resend" ? resend : forgot;
    const results = [];
    for (const error of [null, { code: "user_not_found", status: 400, message: RAW }, { code: "email_address_not_authorized", status: 400, message: RAW }]) {
      method.mockResolvedValue({ error });
      results.push(await call(handler, `/api/auth/${which}`, { email: "person@example.test" }));
    }
    expect(results.map((result) => result.body)).toEqual(Array(3).fill({ ok: true, data: { sent: true, delivery: "unverified" } }));
    expect(results.every((result) => result.response.status === 200)).toBe(true);
    expect(method).toHaveBeenCalledTimes(3); expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["forgot-password", "resend"])("%s surfaces a generic SMTP/provider outage with 503 and does not auto-resend", async (which) => {
    const method = which === "resend" ? sdk.resend : sdk.resetPasswordForEmail;
    method.mockResolvedValue({ error: { code: "unexpected_failure", status: 500, message: RAW, response: RAW } });
    const result = await call(which === "resend" ? resend : forgot, `/api/auth/${which}`, { email: "person@example.test" });
    expect(result.response.status).toBe(503); expect(result.body.error.code).toBe("auth_unavailable");
    expect(result.body.ok).toBe(false); expect(result.body).not.toHaveProperty("data.sent");
    expect(method).toHaveBeenCalledTimes(1); expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not log an attacker-controlled provider error code containing credentials", async () => {
    sdk.signUp.mockResolvedValue({ data: null, error: { code: RAW, status: 500, message: RAW } });
    const result = await call(signUp, "/api/auth/sign-up", { email: "person@example.test", password: "user-password-123" });
    expect(result.response.status).toBe(503); expect(sdk.signUp).toHaveBeenCalledOnce();
  });

  it("does not forward secret-bearing raw provider text even for a recognized password-policy error", async () => {
    sdk.signUp.mockResolvedValue({ data: null, error: { code: "weak_password", status: 400, message: RAW } });
    const result = await call(signUp, "/api/auth/sign-up", { email: "person@example.test", password: "user-password-123" });
    expect(result.response.status).toBe(400); expect(result.body.error.code).toBe("weak_password");
    expect(sdk.signUp).toHaveBeenCalledOnce();
  });

  it("sign-up sender restriction is a safe 503, never a confirmation success", async () => {
    sdk.signUp.mockResolvedValue({ data: null, error: { code: "email_address_not_authorized", status: 400, message: RAW } });
    const result = await call(signUp, "/api/auth/sign-up", { email: "person@example.test", password: "user-password-123" });
    expect(result.response.status).toBe(503); expect(result.body.error.code).toBe("email_unavailable");
    expect(result.body).not.toHaveProperty("data.status"); expect(sdk.signUp).toHaveBeenCalledOnce();
  });

  it("preserves the provider's email quota/rate-limit status", async () => {
    sdk.resetPasswordForEmail.mockResolvedValue({ error: { code: "over_email_send_rate_limit", status: 429, message: RAW } });
    const result = await call(forgot, "/api/auth/forgot-password", { email: "person@example.test" });
    expect(result.response.status).toBe(429); expect(result.body.error.code).toBe("auth_rate_limited");
    expect(sdk.resetPasswordForEmail).toHaveBeenCalledOnce();
  });

  it("retains the real three-requests/minute per-IP forgot-password throttle", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await call(forgot, "/api/auth/forgot-password", { email: "person@example.test" }));
    expect(results.map((result) => result.response.status)).toEqual([200, 200, 200, 429]);
    expect(sdk.resetPasswordForEmail).toHaveBeenCalledTimes(3);
  });

  it("retains real same-origin enforcement before contacting Supabase", async () => {
    const result = await call(signUp, "/api/auth/sign-up", { email: "person@example.test", password: "user-password-123" }, { origin: "https://attacker.example", "sec-fetch-site": "cross-site" });
    expect(result.response.status).toBe(403); expect(sdk.signUp).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an invalid recipient before a Supabase call", async () => {
    const result = await call(forgot, "/api/auth/forgot-password", { email: "not-an-email" });
    expect(result.response.status).toBe(400); expect(sdk.resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

describe("server/client and diagnostic endpoint boundaries", () => {
  it("has no application Nodemailer imports or public SMTP setup/send route", () => {
    const root = path.join(__dirname, "../src");
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
    for (const file of walk(root).filter((file) => /\.(tsx?|mjs)$/.test(file))) {
      const source = readFileSync(file, "utf8");
      const isFeedbackMailer = file.endsWith(path.join("lib", "email", "feedback-mailer.ts"));
      if (!isFeedbackMailer) {
        // Only the feedback mailer may import Nodemailer; every other app file stays SMTP-free.
        expect(source, file).not.toMatch(/(?:from\s+|import\s*\()["'][^"']*(?:nodemailer|scripts\/email\/smtp|scripts\/email\/check-smtp|configure-auth)/);
      }
      if (file.endsWith("logger.ts")) expect(source).toContain('import "server-only"');
      else if (isFeedbackMailer) expect(source, file).toContain('import "server-only"');
      else expect(source, file).not.toMatch(/process\.env\.(?:SMTP_|EMAIL_FROM)/);
    }
  });

  it("pins the feedback mailer contract: server-only, fixed recipient, same Mailjet env names, no other sender", () => {
    const mailer = readFileSync(path.join(__dirname, "../src/lib/email/feedback-mailer.ts"), "utf8");
    expect(mailer).toContain('import "server-only"');
    expect(mailer).toContain("talhaimtiazworks@gmail.com");
    expect(mailer).toContain("env.SMTP_USER");
    expect(mailer).toContain("env.SMTP_PASS");
    expect(mailer).toContain("env.EMAIL_FROM");
    expect(mailer).toContain("in-v3.mailjet.com");
    expect(mailer).toContain("smtp-relay.brevo.com"); // allowlisted Brevo relay (Task: Brevo support)
    expect(mailer).toContain("ALLOWED_SMTP_HOSTS");
    expect(mailer).not.toMatch(/["']?:\s*[^;,]*mail\.to/i); // recipient never taken from caller input
    // The service sends only through the mailer and only ever to the fixed recipient constant.
    const svc = readFileSync(path.join(__dirname, "../src/lib/services/feedback.ts"), "utf8");
    expect(svc).not.toContain("nodemailer");
    expect(svc).not.toContain("@gmail.com");
    expect(svc).toContain("mailer.send("); // through the abstraction only
    // The recipient is applied exactly once, inside the mailer, never from input.
    expect(mailer).toContain("to: FEEDBACK_RECIPIENT");
    expect(svc).not.toContain("FEEDBACK_RECIPIENT");
  });
});
