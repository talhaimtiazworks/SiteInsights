#!/usr/bin/env node
/**
 * Google + GitHub OAuth end-to-end check against a RUNNING SiteInsights server
 * connected to Supabase Auth, following every redirect of the real flow:
 *
 *   app /api/auth/oauth → Supabase /auth/v1/authorize → provider authorize
 *   → Supabase /auth/v1/callback (code exchange with the provider, user lookup)
 *   → app /auth/callback (PKCE code exchange, HttpOnly session cookies) → destination
 *
 * Without real provider credentials it runs against the local provider stand-in
 * (scripts/local-supabase/oauth-mock.mjs, see docs/TESTING.md › OAuth end-to-end):
 *   NODE_EXTRA_CA_CERTS=~/.oauth-mock/ca.pem BASE_URL=http://127.0.0.1:3000 \
 *   MOCK_CONTROL=http://127.0.0.1:7443 SUPABASE_URL=http://127.0.0.1:54321 \
 *   SUPABASE_SERVICE_KEY=… AUDIT_URL=https://example.com node scripts/smoke/oauth-e2e.mjs
 * SUPABASE_SERVICE_KEY is only used to delete the test users at the end.
 */
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const CONTROL = process.env.MOCK_CONTROL ?? "http://127.0.0.1:7443";
const SUPA = process.env.SUPABASE_URL ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_KEY ?? "";
const AUDIT_URL = process.env.AUDIT_URL ?? "";
const RUN = Math.random().toString(36).slice(2, 8);
const results = [];
const createdUsers = new Set();

const step = async (name, fn) => {
  try {
    const v = await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
    return v;
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
    throw e;
  }
};
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const text = (html) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

class Browser {
  jar = new Map();
  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a) || (/expires=/i.test(a) && new Date(a.split("=")[1]) < new Date()));
      if (!v || expired) this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }
  async app(method, path, body) {
    const res = await fetch(new URL(path, BASE), {
      method,
      redirect: "manual",
      headers: { origin: BASE, cookie: this.cookieHeader(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    this.absorb(res);
    const ct = res.headers.get("content-type") ?? "";
    return { status: res.status, headers: res.headers, json: ct.includes("json") ? await res.json() : null, html: ct.includes("html") ? await res.text() : null };
  }
  /** Follows redirects like a browser: app cookies only go to the app; other hosts get none (GoTrue keeps OAuth state server-side). */
  async follow(startUrl) {
    const chain = [];
    let url = startUrl;
    for (let i = 0; i < 12; i++) {
      const u = new URL(url, BASE);
      chain.push(`${u.host}${u.pathname}`);
      let res;
      if (u.origin === new URL(BASE).origin) {
        res = await fetch(u, { redirect: "manual", headers: { cookie: this.cookieHeader() } });
        this.absorb(res);
      } else {
        res = await fetch(u, { redirect: "manual" });
      }
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, u).toString();
        continue;
      }
      return { final: u, status: res.status, chain, body: await res.text() };
    }
    throw new Error(`too many redirects: ${chain.join(" → ")}`);
  }
}

async function mock(provider, identity) {
  const r = await fetch(`${CONTROL}/next`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, ...identity }) });
  assert(r.ok, `mock control failed: ${r.status}`);
}

async function oauth(b, provider, next) {
  const start = await b.app("POST", "/api/auth/oauth", { provider, next });
  assert(start.status === 200 && start.json?.data?.url, `POST /api/auth/oauth → ${start.status} ${JSON.stringify(start.json)}`);
  assert(!/client_secret|sb_secret|service_role/.test(start.json.data.url), "the authorize URL must not contain secrets");
  assert([...b.jar.keys()].some((k) => /code-verifier/.test(k)), "PKCE verifier cookie was not set");
  return b.follow(start.json.data.url);
}

async function session(b) {
  const s = await b.app("GET", "/api/auth/session");
  return s.json?.data;
}

const PROVIDER_HOST = { github: "github.com/login/oauth/authorize", google: "accounts.google.com/o/oauth2/v2/auth" };

async function main() {
  console.log(`OAuth end-to-end against ${BASE}`);
  const ghEmail = `octo-${RUN}@sitelens.localtest`;
  const ggEmail = `gloria-${RUN}@sitelens.localtest`;

  await step("sign-in page shows real Google and GitHub buttons (enabled in Supabase)", async () => {
    const r = await new Browser().app("GET", "/sign-in");
    const t = text(r.html ?? "");
    assert(r.status === 200, `GET /sign-in → ${r.status}`);
    assert(t.includes("Continue with Google") && t.includes("Continue with GitHub"), "OAuth buttons missing");
  });

  const gh = new Browser();
  let ghUserId;
  await step("GitHub: new user → provider → Supabase → /auth/callback → requested dashboard page", async () => {
    await mock("github", { mode: "approve", id: 7_000_000 + Math.floor(Math.random() * 1e6), login: `octo-${RUN}`, name: `Octo ${RUN}`, email: ghEmail, avatar: "https://avatars.githubusercontent.com/u/1?v=4" });
    const r = await oauth(gh, "github", "/dashboard/audits?from=oauth");
    assert(r.chain.some((h) => h.includes("/auth/v1/authorize")), `chain: ${r.chain.join(" → ")}`);
    assert(r.chain.some((h) => h.includes(PROVIDER_HOST.github)), `provider not visited: ${r.chain.join(" → ")}`);
    assert(r.chain.some((h) => h.includes("/auth/v1/callback")), `Supabase callback not visited: ${r.chain.join(" → ")}`);
    assert(r.chain.some((h) => h.endsWith("/auth/callback")), `app callback not visited: ${r.chain.join(" → ")}`);
    assert(r.final.pathname === "/dashboard/audits" && r.final.searchParams.get("from") === "oauth", `landed on ${r.final.pathname}${r.final.search} (chain: ${r.chain.join(" → ")})`);
    assert(r.status === 200, `destination returned ${r.status}`);
    assert(gh.jar.size && [...gh.jar.keys()].some((k) => /^sb-.*-auth-token/.test(k)), "no session cookie");
    const s = await session(gh);
    assert(s?.status === "signed_in" && s.user?.email === ghEmail, `session: ${JSON.stringify(s)}`);
    ghUserId = s.user.id;
    createdUsers.add(ghUserId);
  });

  await step("GitHub user: provider avatar comes from the validated session; dashboard and history load", async () => {
    const s = await session(gh);
    assert(s?.user?.avatarUrl === "https://avatars.githubusercontent.com/u/1?v=4", `session avatar ${s?.user?.avatarUrl}`);
    const a = await gh.app("GET", "/api/account");
    assert(a.status === 200, `GET /api/account → ${a.status} ${JSON.stringify(a.json)}`);
    assert(a.json.data.profile.displayName === `Octo ${RUN}`, `displayName ${a.json.data.profile.displayName}`);
    assert(a.json.data.profile.avatarUrl === s.user.avatarUrl, "account profile did not use the validated session avatar");
    assert(a.json.data.user.providers.includes("github"), `providers ${a.json.data.user.providers}`);
    const d = await gh.app("GET", "/api/dashboard");
    assert(d.status === 200 && d.json.data.stats.total === 0, `dashboard → ${d.status} ${JSON.stringify(d.json).slice(0, 200)}`);
    const page = await gh.app("GET", "/dashboard");
    assert(page.status === 200, `GET /dashboard → ${page.status}`);
  });

  if (AUDIT_URL) {
    await step("GitHub user: an audit is saved to the account and listed in history", async () => {
      const s = await gh.app("POST", "/api/scans", { url: AUDIT_URL });
      assert(s.status === 201 || s.status === 202 || s.status === 200, `POST /api/scans → ${s.status} ${JSON.stringify(s.json)}`);
      const id = s.json.data.id ?? s.json.data.scan?.id;
      const list = await gh.app("GET", "/api/audits");
      assert(list.status === 200 && JSON.stringify(list.json).includes(id), "audit not in history");
    });
  }

  await step("sign out, then GitHub again → returning user gets the same account (no duplicate)", async () => {
    const o = await gh.app("POST", "/api/auth/sign-out", {});
    assert(o.status === 200, `sign-out → ${o.status}`);
    assert((await session(gh))?.status !== "signed_in", "still signed in after sign-out");
    const r = await oauth(gh, "github", "/dashboard");
    assert(r.final.pathname === "/dashboard" && r.status === 200, `landed on ${r.final.pathname}`);
    const s = await session(gh);
    assert(s?.user?.id === ghUserId, `different user id on return: ${s?.user?.id} vs ${ghUserId}`);
    if (AUDIT_URL) {
      const list = await gh.app("GET", "/api/audits");
      assert((list.json.data.items ?? list.json.data.audits ?? []).length >= 1 || JSON.stringify(list.json).includes("\"id\""), "earlier audit missing after returning");
    }
  });

  await step("GitHub: user cancels at the provider → back on sign-in with a clear message, not signed in", async () => {
    const b = new Browser();
    await mock("github", { mode: "deny" });
    const r = await oauth(b, "github", "/dashboard");
    await mock("github", { mode: "approve" });
    assert(r.final.pathname === "/sign-in", `landed on ${r.final.pathname}${r.final.search}`);
    assert(r.final.searchParams.get("error") === "access_denied", `error=${r.final.searchParams.get("error")}`);
    assert(r.final.searchParams.get("next") === "/dashboard", "destination not preserved for retry");
    assert(text(r.body).includes("Sign-in was cancelled."), "cancel message not shown");
    assert((await session(b))?.status !== "signed_in", "signed in after cancelling");
  });

  const gg = new Browser();
  let ggUserId;
  await step("Google (OIDC, signed ID token): new user lands on the dashboard", async () => {
    await mock("google", { mode: "approve", sub: `${Date.now()}${RUN.length}`, name: `Gloria ${RUN}`, email: ggEmail, picture: "https://lh3.googleusercontent.com/a/test" });
    const r = await oauth(gg, "google", "/dashboard");
    assert(r.chain.some((h) => h.includes(PROVIDER_HOST.google)), `provider not visited: ${r.chain.join(" → ")}`);
    assert(r.final.pathname === "/dashboard" && r.status === 200, `landed on ${r.final.pathname}${r.final.search} (chain: ${r.chain.join(" → ")})`);
    const s = await session(gg);
    assert(s?.status === "signed_in" && s.user.email === ggEmail, `session ${JSON.stringify(s)}`);
    assert(s.user.avatarUrl === null, "Google picture must not be used as a SiteInsights avatar");
    ggUserId = s.user.id;
    createdUsers.add(ggUserId);
    assert(ggUserId !== ghUserId, "Google user must be a different account");
    const a = await gg.app("GET", "/api/account");
    assert(a.json.data.profile.displayName === `Gloria ${RUN}` && a.json.data.user.providers.includes("google"), "Google profile not created");
    assert(a.json.data.profile.avatarUrl === null, "Google picture must not be exposed as the profile avatar");
  });

  await step("isolation: the Google user cannot see the GitHub user's audits", async () => {
    const mine = await gg.app("GET", "/api/audits");
    assert(mine.status === 200, `GET /api/audits → ${mine.status}`);
    const d = await gg.app("GET", "/api/dashboard");
    assert(d.json.data.stats.total === 0, "Google user sees audits that are not theirs");
  });

  await step("Google with the GitHub user's verified email → the same account (Supabase identity linking)", async () => {
    const b = new Browser();
    await mock("google", { mode: "approve", sub: `${Date.now()}9`, name: `Octo ${RUN}`, email: ghEmail, picture: "https://lh3.googleusercontent.com/a/test2" });
    const r = await oauth(b, "google", "/dashboard");
    assert(r.final.pathname === "/dashboard", `landed on ${r.final.pathname}${r.final.search}`);
    const s = await session(b);
    assert(s?.user?.id === ghUserId, `expected the existing account ${ghUserId}, got ${s?.user?.id}`);
    assert(s?.user?.avatarUrl === null, "Google-authenticated session must not inherit the linked GitHub avatar");
    const a = await b.app("GET", "/api/account");
    assert(a.json.data.user.providers.includes("github") && a.json.data.user.providers.includes("google"), `providers ${a.json.data.user.providers}`);
  });

  await step("Google: user cancels → sign-in page with message", async () => {
    const b = new Browser();
    await mock("google", { mode: "deny" });
    const r = await oauth(b, "google", "/dashboard/audits");
    await mock("google", { mode: "approve" });
    assert(r.final.pathname === "/sign-in" && r.final.searchParams.get("error") === "access_denied", `landed on ${r.final.pathname}${r.final.search}`);
    assert(r.final.searchParams.get("next") === "/dashboard/audits", "destination not preserved");
  });

  await step("open redirects are refused: next=https://evil.example → stays on this site", async () => {
    const b = new Browser();
    await mock("github", { mode: "approve" });
    const r = await oauth(b, "github", "https://evil.example/steal");
    assert(r.final.origin === new URL(BASE).origin, `left the site: ${r.final}`);
  });
}

try {
  await main();
} catch {
  /* reported per step */
} finally {
  if (SUPA && SERVICE) {
    for (const id of createdUsers) await fetch(`${SUPA}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } }).catch(() => null);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} steps passed${createdUsers.size ? `; ${createdUsers.size} test users ${SUPA && SERVICE ? "deleted" : "left in place"}` : ""}`);
  process.exit(failed ? 1 : 0);
}
