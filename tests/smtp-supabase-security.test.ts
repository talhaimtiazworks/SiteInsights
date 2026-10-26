/** No live Management API calls or SMTP connections: injected fetch and loopback stubs only. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfigureAuth } from "../scripts/supabase/configure-auth.mjs";
import type { EmailEnvironment } from "../scripts/email/smtp-config.mjs";

const REF = "qrstuvwxyz0123456789";
import { MAILJET_TEST_USER as USER, MAILJET_TEST_PASS as PASS, MAILJET_TEST_FROM as FROM, MAILJET_TEST_ENV } from "./fixtures/mailjet-smtp";
const TOKEN = "sbp_synthetic_test_token_only";
const env: EmailEnvironment = { ...MAILJET_TEST_ENV, SUPABASE_ACCESS_TOKEN: TOKEN, SUPABASE_PROJECT_REF: REF };
const state = { site_url: "https://sitelens-ai.vercel.app", uri_allow_list: "https://sitelens-ai.vercel.app/**,https://keep.example/**", mailer_autoconfirm: false, security_captcha_enabled: true, rate_limit_email_sent: 30, external_google_enabled: true };
function setup() {
  let config: Record<string, unknown> = { ...state };
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === "PATCH") config = { ...config, ...JSON.parse(String(init.body)) };
    return Response.json(config);
  });
  const output = vi.fn(); const errorOutput = vi.fn();
  const run = (argv: string[], extra: EmailEnvironment = {}) => runConfigureAuth({ argv, env: { ...env, ...extra }, fetchImpl, output, errorOutput });
  const logs = () => [...output.mock.calls, ...errorOutput.mock.calls].flat().join("\n");
  return { fetchImpl, output, errorOutput, run, logs, config: () => config };
}
function expectPrivate(text: string) {
  for (const value of [USER, PASS, FROM, TOKEN, "raw-provider-secret"]) expect(text).not.toContain(value);
  expect(text).not.toContain("Error: raw");
}
afterEach(() => vi.restoreAllMocks());

describe("Mailjet → hosted Supabase setup security", () => {
  it("dry-run reads only and logs a redacted six-field plan without sending mail", async () => {
    const s = setup(); expect(await s.run(["--smtp"])).toBe(0);
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(s.fetchImpl.mock.calls[0][0]).toBe(`https://api.supabase.com/v1/projects/${REF}/config/auth`);
    expect(s.fetchImpl.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(s.fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(s.config()).toEqual(state);
    expect(s.logs()).toContain("dry run"); expectPrivate(s.logs());
  });

  it("writes exactly once, preserves URLs/providers/limits and validates only non-secret read-back fields", async () => {
    const s = setup(); expect(await s.run(["--smtp", "--apply"])).toBe(0);
    expect(s.fetchImpl.mock.calls.map((call) => call[1]?.method)).toEqual(["GET", "PATCH", "GET"]);
    const patch = JSON.parse(String(s.fetchImpl.mock.calls[1][1]?.body));
    expect(Object.keys(patch).sort()).toEqual(["smtp_admin_email", "smtp_host", "smtp_pass", "smtp_port", "smtp_sender_name", "smtp_user"]);
    for (const [key, value] of Object.entries(state)) expect(s.config()[key]).toEqual(value);
    expect(s.logs()).toContain("SMTP authentication and inbox delivery remain unverified"); expectPrivate(s.logs());
  });

  it.each([
    ["missing password", { SMTP_PASS: "" }],
    ["invalid sender syntax", { EMAIL_FROM: "SiteInsights <invalid@example.test>" }],
    ["wrong host", { SMTP_HOST: "evil.example.test" }],
    ["missing token", { SUPABASE_ACCESS_TOKEN: "" }],
    ["invalid project", { SUPABASE_PROJECT_REF: "invalid-ref" }],
    ["public password", { NEXT_PUBLIC_SMTP_PASS: PASS }],
  ] as Array<[string, EmailEnvironment]>)("rejects %s before any Management API request", async (_label, extra) => {
    const s = setup(); expect(await s.run(["--smtp", "--apply"], extra)).toBe(1);
    expect(s.fetchImpl).not.toHaveBeenCalled(); expectPrivate(s.logs());
  });

  it.each([
    { CONFIGURE_AUTH_API_BASE: "https://attacker.example", NODE_ENV: "test" },
    { CONFIGURE_AUTH_API_BASE: "http://127.0.0.1:1234", NODE_ENV: "production" },
    { CONFIGURE_AUTH_API_BASE: "http://attacker.example", NODE_ENV: "test" },
    { CONFIGURE_AUTH_API_BASE: "http://user:password@127.0.0.1", NODE_ENV: "test" },
  ])("cannot redirect credentials using a non-test/non-loopback API override (%j)", async (extra) => {
    const s = setup(); expect(await s.run(["--smtp", "--apply"], extra)).toBe(1);
    expect(s.fetchImpl).not.toHaveBeenCalled(); expect(s.logs()).toContain("unsafe_api_override"); expectPrivate(s.logs());
  });

  it("never prints an error response body containing passwords, addresses or access tokens", async () => {
    const s = setup();
    s.fetchImpl.mockResolvedValue(new Response(JSON.stringify({ message: `raw-provider-secret ${USER} ${PASS} ${TOKEN}`, stack: "provider-internals" }), { status: 400 }));
    expect(await s.run(["--smtp", "--apply"])).toBe(1);
    expect(s.fetchImpl).toHaveBeenCalledOnce(); expect(s.logs()).toContain("HTTP 400"); expectPrivate(s.logs());
    expect(s.logs()).not.toContain("provider-internals");
  });

  it("never prints an exception or stack supplied by the network provider", async () => {
    const s = setup(); s.fetchImpl.mockRejectedValue(new Error(`raw-provider-secret ${USER} ${PASS} ${TOKEN}`));
    expect(await s.run(["--smtp"])).toBe(1);
    expect(s.logs()).toContain("auth_settings_unavailable"); expectPrivate(s.logs()); expect(s.fetchImpl).toHaveBeenCalledOnce();
  });

  it("bounds request timeouts and sanitizes a timed-out read without retrying", async () => {
    const original = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => original(5));
    const s = setup();
    s.fetchImpl.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    expect(await s.run(["--smtp", "--apply"])).toBe(1);
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(s.fetchImpl).toHaveBeenCalledOnce(); expect(s.logs()).toContain("auth_settings_timeout"); expectPrivate(s.logs());
  });

  it("does not repeat an uncertain PATCH or claim it failed before checking the dashboard", async () => {
    const s = setup();
    s.fetchImpl.mockImplementation(async (_url, init) => {
      if (init?.method === "PATCH") throw Object.assign(new Error(`raw-provider-secret ${PASS}`), { name: "TimeoutError" });
      return Response.json(state);
    });
    expect(await s.run(["--smtp", "--apply"])).toBe(1);
    expect(s.fetchImpl.mock.calls.map((call) => call[1]?.method)).toEqual(["GET", "PATCH"]);
    expect(s.logs()).toContain("update may already have applied"); expect(s.logs()).toContain("No automatic retry"); expectPrivate(s.logs());
  });

  it("does not print a rejected PATCH response or reapply it", async () => {
    const s = setup();
    s.fetchImpl.mockImplementation(async (_url, init) => init?.method === "PATCH"
      ? Response.json({ message: `raw-provider-secret ${PASS} ${USER} ${TOKEN}` }, { status: 422 })
      : Response.json(state));
    expect(await s.run(["--smtp", "--apply"])).toBe(1);
    expect(s.fetchImpl.mock.calls.map((call) => call[1]?.method)).toEqual(["GET", "PATCH"]);
    expect(s.logs()).toContain("HTTP 422"); expectPrivate(s.logs());
  });

  it("fails safely on malformed/secret-bearing read-back rather than claiming success", async () => {
    const s = setup();
    s.fetchImpl.mockImplementation(async (_url, init) => init?.method === "PATCH" ? Response.json({}) : Response.json(state));
    expect(await s.run(["--smtp", "--apply"])).toBe(1);
    expect(s.logs()).toContain("auth_settings_readback_mismatch"); expect(s.logs()).not.toContain("Saved and read back"); expectPrivate(s.logs());
    expect(s.fetchImpl.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(1);
  });

  it("--templates can preserve SiteURL-based templates without forcing a new origin", async () => {
    const s = setup(); expect(await s.run(["--templates"])).toBe(0);
    expect(s.logs()).toMatch(/mailer_templates_confirmation_content = \d+ chars/);
    expect(s.logs()).not.toContain("site_url ="); expect(s.logs()).not.toContain("smtp_pass");
    expect(s.fetchImpl).toHaveBeenCalledOnce(); expectPrivate(s.logs());
  });

  it("does not weaken redirect validation and merges rather than erases the legacy allowlist", async () => {
    const s = setup();
    expect(await s.run(["--urls", "--app-url", "https://siteinsight.xyz", "--apply"])).toBe(0);
    expect(s.config().uri_allow_list).toContain("https://sitelens-ai.vercel.app/**");
    expect(s.config().uri_allow_list).toContain("https://keep.example/**");
    expect(s.logs()).toContain("existing entries preserved");
    const bad = setup(); expect(await bad.run(["--urls", "--app-url", "https://user:password@siteinsight.xyz"])).toBe(1);
    expect(bad.fetchImpl).not.toHaveBeenCalled(); expectPrivate(bad.logs());
  });

  it.each([["--smtp", "--smtp"], ["--smtp", "--password", PASS], ["--smtp", "--app-url"], []])("rejects invalid flags without network access (%j)", async (...argv) => {
    const s = setup(); expect(await s.run(argv as string[])).toBe(1);
    expect(s.fetchImpl).not.toHaveBeenCalled(); expectPrivate(s.logs());
  });
});
