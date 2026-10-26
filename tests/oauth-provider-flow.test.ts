import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetConfigForTests } from "@/lib/config/env";
import { __resetRateLimitsForTests } from "@/lib/http/rate-limit";
import {
  OAUTH_PROVIDER_STATE_COOKIE,
  SESSION_PROVIDER_COOKIE,
  createOAuthProviderState,
  readSessionProviderMarker,
  verifyOAuthProviderState,
} from "@/lib/auth/session-provider";

const mocks = vi.hoisted(() => ({
  auth: {
    signInWithOAuth: vi.fn(),
    linkIdentity: vi.fn(),
    exchangeCodeForSession: vi.fn(),
    getClaims: vi.fn(),
  },
  requireUser: vi.fn(),
  getAuthProviders: vi.fn(),
  syncProfileAfterSignIn: vi.fn(),
}));

vi.mock("@/lib/auth/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth/server")>(),
  authEnabled: () => true,
  supabaseForRequest: () => ({ auth: mocks.auth }),
  requireUser: mocks.requireUser,
}));
vi.mock("@/lib/auth/providers", () => ({ getAuthProviders: mocks.getAuthProviders }));
vi.mock("@/lib/auth/route-helpers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth/route-helpers")>(),
  syncProfileAfterSignIn: mocks.syncProfileAfterSignIn,
}));

import { POST as startOAuth } from "@/app/api/auth/oauth/route";
import { GET as authCallback } from "@/app/auth/callback/route";

const ORIGIN = "https://siteinsight.test";
const SECRET = "local-test-session-signing-secret-with-32-bytes";
const USER_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const GITHUB_AVATAR = "https://avatars.githubusercontent.com/u/583231?v=4";
const SAVED_ENV = { ...process.env };

function configEnv() {
  process.env = {
    ...SAVED_ENV,
    NODE_ENV: "test",
    NEXT_PUBLIC_APP_URL: ORIGIN,
    NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key_for_oauth_flow",
    SESSION_SECRET: SECRET,
  };
  __resetConfigForTests();
  __resetRateLimitsForTests();
}

function oauthRequest(body: unknown) {
  return new NextRequest(`${ORIGIN}/api/auth/oauth`, {
    method: "POST",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-real-ip": "192.0.2.42" },
    body: JSON.stringify(body),
  });
}

function callbackRequest(state: string, next = "/dashboard", extraCookies: string[] = []) {
  const query = new URLSearchParams({ code: "fixture-code", next, oauth_provider_state: state });
  return new NextRequest(`${ORIGIN}/auth/callback?${query}`, {
    headers: { cookie: [`${OAUTH_PROVIDER_STATE_COOKIE}=${state}`, ...extraCookies].join("; ") },
  });
}

function responseCookie(response: Response, name: string) {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  if (!header) return undefined;
  const [pair, ...attributes] = header.split(";");
  return {
    value: decodeURIComponent(pair.slice(pair.indexOf("=") + 1)),
    httpOnly: attributes.some((attribute) => attribute.trim().toLowerCase() === "httponly"),
    maxAge: attributes.map((attribute) => /^\s*max-age=(\d+)/i.exec(attribute)?.[1]).find(Boolean),
  };
}

function verifiedClaims(provider = "github") {
  return {
    sub: USER_ID,
    session_id: SESSION_ID,
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
    amr: [{ method: "oauth", provider }],
    app_metadata: { provider: "github", providers: ["github", "google"] },
  };
}

beforeEach(() => {
  configEnv();
  for (const fn of Object.values(mocks.auth)) fn.mockReset();
  mocks.requireUser.mockReset().mockResolvedValue({ id: USER_ID, email: "user@example.test" });
  mocks.getAuthProviders.mockReset().mockResolvedValue({ enabled: true, email: true, google: true, github: true, saml: false, signupDisabled: false, unavailable: false });
  mocks.syncProfileAfterSignIn.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
  __resetConfigForTests();
  __resetRateLimitsForTests();
});

describe("OAuth provider/session provenance routes", () => {
  it("signs the selected sign-in provider into redirect state and an HttpOnly cookie", async () => {
    mocks.auth.signInWithOAuth.mockResolvedValue({ data: { url: "https://abcdefghijklmnopqrst.supabase.co/auth/v1/authorize?provider=github" }, error: null });
    const res = await startOAuth(oauthRequest({ provider: "github", next: "/dashboard/audits" }), {} as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { url: string } };
    expect(body.data.url).toContain("/auth/v1/authorize");

    const options = mocks.auth.signInWithOAuth.mock.calls[0][0].options;
    const redirect = new URL(options.redirectTo);
    const state = redirect.searchParams.get("oauth_provider_state");
    const cookie = responseCookie(res, OAUTH_PROVIDER_STATE_COOKIE)?.value;
    expect(state).toBeTruthy();
    expect(cookie).toBe(state);
    expect(redirect.searchParams.get("next")).toBe("/dashboard/audits");
    expect(verifyOAuthProviderState(state, SECRET)).toMatchObject({ provider: "github", mode: "sign_in" });
    expect(responseCookie(res, OAUTH_PROVIDER_STATE_COOKIE)?.httpOnly).toBe(true);
  });

  it("signs an OAuth registration intent while retaining the existing-user destination as the fallback", async () => {
    mocks.auth.signInWithOAuth.mockResolvedValue({ data: { url: "https://abcdefghijklmnopqrst.supabase.co/auth/v1/authorize?provider=google" }, error: null });
    const res = await startOAuth(oauthRequest({ provider: "google", next: "/audit/new", mode: "sign_up" }), {} as never);
    expect(res.status).toBe(200);
    const options = mocks.auth.signInWithOAuth.mock.calls[0][0].options;
    const redirect = new URL(options.redirectTo);
    const state = redirect.searchParams.get("oauth_provider_state");
    expect(verifyOAuthProviderState(state, SECRET)).toMatchObject({ provider: "google", mode: "sign_up" });
    expect(redirect.searchParams.get("next")).toBe("/audit/new");
  });

  it("marks linking as a distinct signed flow and leaves callback provenance handling to that mode", async () => {
    mocks.auth.linkIdentity.mockResolvedValue({ data: { url: "https://abcdefghijklmnopqrst.supabase.co/auth/v1/authorize?provider=google" }, error: null });
    const res = await startOAuth(oauthRequest({ provider: "google", mode: "link" }), {} as never);
    expect(res.status).toBe(200);
    const options = mocks.auth.linkIdentity.mock.calls[0][0].options;
    const redirect = new URL(options.redirectTo);
    const state = redirect.searchParams.get("oauth_provider_state");
    expect(state).toBe(responseCookie(res, OAUTH_PROVIDER_STATE_COOKIE)?.value);
    expect(verifyOAuthProviderState(state, SECRET)).toMatchObject({ provider: "google", mode: "link" });
    expect(redirect.searchParams.get("next")).toBe("/account/connections?linked=google");
  });

  it("routes a newly created OAuth account to profile setup", async () => {
    const state = createOAuthProviderState("google", SECRET, "sign_up")!;
    mocks.auth.exchangeCodeForSession.mockResolvedValue({
      data: { session: { access_token: "fixture", refresh_token: "fixture" }, user: { id: USER_ID, created_at: new Date().toISOString(), identities: [{ provider: "google", last_sign_in_at: new Date().toISOString() }] } },
      error: null,
    });
    mocks.auth.getClaims.mockResolvedValue({ data: { claims: verifiedClaims("google") }, error: null });
    const res = await authCallback(callbackRequest(state, "/audit/new"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/account/professional-profile");
  });

  it("also onboards a first-time account created through an OAuth button on the sign-in page", async () => {
    const state = createOAuthProviderState("google", SECRET, "sign_in")!;
    mocks.auth.exchangeCodeForSession.mockResolvedValue({
      data: { session: { access_token: "fixture", refresh_token: "fixture" }, user: { id: USER_ID, created_at: new Date().toISOString() } },
      error: null,
    });
    mocks.auth.getClaims.mockResolvedValue({ data: { claims: verifiedClaims("google") }, error: null });
    const res = await authCallback(callbackRequest(state, "/audit/new"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/account/professional-profile");
  });

  it("keeps an existing OAuth account on the requested login destination, even from the sign-up page", async () => {
    const state = createOAuthProviderState("google", SECRET, "sign_up")!;
    const verifiedState = verifyOAuthProviderState(state, SECRET)!;
    mocks.auth.exchangeCodeForSession.mockResolvedValue({
      data: { session: { access_token: "fixture", refresh_token: "fixture" }, user: { id: USER_ID, created_at: new Date((verifiedState.issuedAt - 60) * 1000).toISOString(), identities: [{ provider: "google", last_sign_in_at: new Date().toISOString() }] } },
      error: null,
    });
    mocks.auth.getClaims.mockResolvedValue({ data: { claims: verifiedClaims("google") }, error: null });
    const res = await authCallback(callbackRequest(state, "/audit/new"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/audit/new");
  });

  it("binds a GitHub avatar to the session only after a verified GitHub OAuth callback", async () => {
    const state = createOAuthProviderState("github", SECRET)!;
    mocks.auth.exchangeCodeForSession.mockResolvedValue({
      data: { session: { access_token: "fixture", refresh_token: "fixture" }, user: { id: USER_ID, identities: [{ provider: "github", last_sign_in_at: new Date().toISOString(), identity_data: { avatar_url: GITHUB_AVATAR } }] } },
      error: null,
    });
    mocks.auth.getClaims.mockResolvedValue({ data: { claims: verifiedClaims("github") }, error: null });

    const res = await authCallback(callbackRequest(state));
    expect(res.status).toBe(307);
    const marker = responseCookie(res, SESSION_PROVIDER_COOKIE)?.value;
    expect(readSessionProviderMarker(marker, SESSION_ID, SECRET)).toEqual({ provider: "github", avatarUrl: GITHUB_AVATAR });
    expect(responseCookie(res, OAUTH_PROVIDER_STATE_COOKIE)?.maxAge).toBe("0");
  });

  it("uses the default for a Google callback on a GitHub-linked account", async () => {
    const state = createOAuthProviderState("google", SECRET)!;
    mocks.auth.exchangeCodeForSession.mockResolvedValue({
      data: {
        session: { access_token: "fixture", refresh_token: "fixture" },
        user: { id: USER_ID, identities: [
          { provider: "github", last_sign_in_at: "2026-10-19T10:00:00.000Z", identity_data: { avatar_url: GITHUB_AVATAR } },
          { provider: "google", last_sign_in_at: new Date().toISOString(), identity_data: { picture: "https://lh3.googleusercontent.com/a/test" } },
        ] },
      },
      error: null,
    });
    mocks.auth.getClaims.mockResolvedValue({ data: { claims: verifiedClaims("google") }, error: null });

    const res = await authCallback(callbackRequest(state));
    const marker = responseCookie(res, SESSION_PROVIDER_COOKIE)?.value;
    expect(readSessionProviderMarker(marker, SESSION_ID, SECRET)).toEqual({ provider: "google", avatarUrl: null });
  });

  it("does not replace a signed-in session marker during an account-link callback", async () => {
    const state = createOAuthProviderState("google", SECRET, "link")!;
    const oldMarker = "v1.github.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.LQ.signature-fixture";
    mocks.auth.exchangeCodeForSession.mockResolvedValue({ data: { session: { access_token: "fixture" }, user: { id: USER_ID } }, error: null });

    const res = await authCallback(callbackRequest(state, "/account/connections?linked=google", [`${SESSION_PROVIDER_COOKIE}=${oldMarker}`]));
    expect(res.status).toBe(307);
    expect(responseCookie(res, SESSION_PROVIDER_COOKIE)).toBeUndefined();
    expect(mocks.auth.getClaims).not.toHaveBeenCalled();
  });
});
