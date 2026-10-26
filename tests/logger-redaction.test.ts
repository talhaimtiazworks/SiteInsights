/**
 * The server logger must never write credentials, session tokens or personal
 * data — including values that appear inside error messages from Supabase,
 * Postgres or AI providers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger, redact } from "@/lib/logger";

import { MAILJET_TEST_USER as USER, MAILJET_TEST_PASS as PASS, MAILJET_TEST_FROM as FROM } from "./fixtures/mailjet-smtp";

const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ";

afterEach(() => vi.unstubAllEnvs());

describe("redact()", () => {
  it.each([
    ["Supabase secret key", "key sb_secret_AbCdEf123456_xyz7890 rejected", "sb_secret_AbCdEf123456_xyz7890"],
    ["Supabase publishable key", "using sb_publishable_ZYXwvu987654321", "sb_publishable_ZYXwvu987654321"],
    ["JWT / legacy service_role key", `token ${jwt} expired`, jwt],
    ["Bearer header", "Authorization: Bearer abcdefghijklmnop.qrs", "abcdefghijklmnop"],
    ["session cookie", "sb-abcd1234-auth-token.0=base64-eyJhY2Nlc3NfdG9rZW4iOiJ4In0; Path=/", "base64-eyJhY2Nlc3NfdG9rZW4iOiJ4In0"],
    ["PKCE verifier cookie", "sb-abcd-auth-token-code-verifier=verifier-value-123", "verifier-value-123"],
    ["full Cookie header", "cookie: sl_pid=anon-id-123; sb-x-auth-token=secretvalue", "anon-id-123"],
    ["email link token_hash", "GET /auth/confirm?token_hash=pkce_abcdef123456&type=signup", "pkce_abcdef123456"],
    ["OAuth code", "callback /auth/callback?code=4f9c2a1b-77aa-4e3e&next=%2Fdashboard", "4f9c2a1b-77aa-4e3e"],
    ["refresh token field", '{"refresh_token":"v1.refresh-abcdef"}', "v1.refresh-abcdef"],
    ["password field", "password=hunter2-secret", "hunter2-secret"],
    ["SMTP password field", "SMTP_PASS=abcdefghijklmnop", "abcdefghijklmnop"],
    ["legacy grouped secret field", "SMTP_PASS=abcd efgh ijkl mnop failed", "abcd efgh ijkl mnop"],
    ["legacy JSON grouped secret field", '{"SMTP_PASS":"abcd efgh ijkl mnop"}', "abcd efgh ijkl mnop"],
    ["legacy human credential field", "App Password: abcd efgh ijkl mnop", "abcd efgh ijkl mnop"],
    ["Mailjet API key SMTP username", `SMTP_USER=${USER}`, USER],
    ["email sender field", '{"EMAIL_FROM":"private-operator@example.test"}', "private-operator@example.test"],
    ["Management API token", "SUPABASE_ACCESS_TOKEN=sbp_test_management_token", "sbp_test_management_token"],
    ["Mailjet SMTP URL", `failed smtps://${USER}:${PASS}@in-v3.mailjet.com:465`, PASS],
    ["Mailjet API key field", `MAILJET_API_KEY=${USER}`, USER],
    ["Mailjet Secret Key field", `MAILJET_SECRET_KEY=${PASS}`, PASS],
    ["Mailjet API key human label", `Mailjet API Key: ${USER}`, USER],
    ["Mailjet Secret Key human label", `Mailjet Secret Key: ${PASS}`, PASS],
    ["Mailjet Secret Key JSON", JSON.stringify({ SecretKey: PASS }), PASS],
    ["provider API key label", `MJ_APIKEY_PUBLIC=${USER}`, USER],
    ["provider secret key label", `MJ_APIKEY_PRIVATE=${PASS}`, PASS],
    ["database URL", "connect postgres://user:pw@db.example.com:6543/postgres failed", "user:pw@db.example.com"],
    ["OpenRouter key", "bad key sk-or-v1-abcdef0123456789", "sk-or-v1-abcdef0123456789"],
    ["Google key", "key AIzaSyA1234567890abcdefghijklmno", "AIzaSyA1234567890abcdefghijklmno"],
  ])("removes %s", (_label, input, secret) => {
    const out = redact(input);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  it("masks email addresses but keeps the domain for diagnostics", () => {
    const out = redact("User already registered: jane.doe+test@example.co.uk (signup)");
    expect(out).not.toContain("jane.doe");
    expect(out).toContain("j***@example.co.uk");
  });

  it("removes known API key, Secret Key and sender even from unlabeled raw/encoded provider messages", () => {
    vi.stubEnv("SMTP_PASS", PASS); vi.stubEnv("SMTP_USER", USER); vi.stubEnv("EMAIL_FROM", FROM);
    const values = [USER, PASS, FROM, ...[USER, PASS, FROM].map(encodeURIComponent), ...[USER, PASS].map((value) => Buffer.from(value).toString("base64")), Buffer.from(`${USER}:${PASS}`).toString("base64"), Buffer.from(`\0${USER}\0${PASS}`).toString("base64")];
    const result = redact(values.join(" "));
    for (const value of values) expect(result).not.toContain(value);
    expect(result).toContain("[REDACTED]");
  });

  it("leaves ordinary diagnostics readable", () => {
    const msg = "Scan 6f1c failed with an internal error: timeout after 20000 ms at https://example.com/page?id=4";
    expect(redact(msg)).toBe(msg);
  });
});

describe("logger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("redacts error objects and extra data before writing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("Supabase Auth failed for owner@example.com", new Error(`invalid JWT ${jwt} with sb_secret_ZZZZZZZZ1234`));
    logger.error("Unhandled API error", { cookie: "sb-p-auth-token=abc.def.ghi; sl_pid=xyz", url: "/auth/confirm?token_hash=th_123456789" });
    const written = spy.mock.calls.flat().join("\n");
    expect(written).not.toMatch(/owner@|eyJhbGci|sb_secret_ZZZZ|abc\.def\.ghi|th_123456789|sl_pid=xyz/);
    expect(written).toContain("o***@example.com");
  });
});
