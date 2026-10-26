/**
 * Sign-out must remove the session cookies from the browser in every case —
 * including when the session can't be refreshed or revoked because Supabase
 * Auth is unreachable (supabase-js returns early without clearing cookies when
 * loading the session fails). Uses an unreachable Auth URL on purpose.
 */
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { __resetConfigForTests } from "@/lib/config/env";

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
  __resetConfigForTests();
});

function b64url(s: string) {
  return Buffer.from(s).toString("base64url");
}

describe("POST /api/auth/sign-out", () => {
  it("expires every Supabase auth cookie even when Auth is unreachable and the session is expired", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9"; // discard port: connection refused
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test_only_0000000000";
    process.env.NEXT_PUBLIC_APP_URL = "http://sitelens.localtest";
    __resetConfigForTests();
    const { POST } = await import("@/app/api/auth/sign-out/route");

    const past = Math.floor(Date.now() / 1000) - 3600;
    const jwt = `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(JSON.stringify({ sub: "00000000-0000-4000-8000-000000000001", exp: past, role: "authenticated" }))}.sig`;
    const session = { access_token: jwt, refresh_token: "refresh-token-value", expires_at: past, expires_in: 3600, token_type: "bearer", user: { id: "00000000-0000-4000-8000-000000000001" } };
    const value = "base64-" + b64url(JSON.stringify(session));
    // Chunked like large real sessions, plus a stale PKCE verifier and an unrelated cookie.
    const cookie = [`sb-127-auth-token.0=${value.slice(0, 40)}`, `sb-127-auth-token.1=${value.slice(40)}`, "sb-127-auth-token-code-verifier=verifier", "sl_pid=anon-browser-id"].join("; ");

    const req = new NextRequest("http://sitelens.localtest/api/auth/sign-out", {
      method: "POST",
      headers: { origin: "http://sitelens.localtest", cookie, "content-type": "application/json" },
      body: "{}",
    });
    const started = Date.now();
    const res = await POST(req, { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(200);
    // Answers within the revoke wait (4 s) instead of waiting out supabase-js's ~30 s refresh retries.
    expect(Date.now() - started).toBeLessThan(8000);
    const setCookies = res.headers.getSetCookie();
    for (const name of ["sb-127-auth-token.0", "sb-127-auth-token.1", "sb-127-auth-token-code-verifier", "si_session_provider", "si_oauth_provider_state"]) {
      const c = setCookies.find((x) => x.startsWith(`${name}=`));
      expect(c, `${name} must be expired`).toBeDefined();
      expect(c).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
      expect(c).toMatch(/Path=\//);
    }
    // The anonymous audit cookie is not an auth cookie and stays.
    expect(setCookies.some((x) => x.startsWith("sl_pid="))).toBe(false);
    const body = (await res.json()) as { ok: boolean; data: { signedOut: boolean } };
    expect(body).toMatchObject({ ok: true, data: { signedOut: true, sessionRevoked: false } });
  }, 20_000);
});
