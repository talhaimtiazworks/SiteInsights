/**
 * Accounts integration tests: REAL Supabase Auth (GoTrue) + the real proxy.ts
 * and route handlers + a Postgres database with the Supabase schema.
 *
 * Runs only when these are set (otherwise skipped, reported as not run):
 *   TEST_SUPABASE_URL               e.g. http://127.0.0.1:54321 (local) or https://<ref>.supabase.co (a TEST project)
 *   TEST_SUPABASE_ANON_KEY          publishable / anon key
 *   TEST_SUPABASE_SERVICE_ROLE_KEY  secret / service-role key (used only by the test to create/delete users)
 *   TEST_SUPABASE_DATABASE_URL      direct Postgres URL of the same project (migrations applied)
 *
 * Users are created with the Auth admin API (email pre-confirmed) and removed afterwards.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", async () => (await import("./helpers/route-harness")).nextHeadersMock);
vi.mock("@/lib/security/safe-fetch", async (orig) => {
  const m = await orig<typeof import("@/lib/security/safe-fetch")>();
  return {
    ...m,
    resolvePublicHost: async (host: string) =>
      /\.sitelens-fixture\.(com|net)$/.test(host) ? { ok: true as const, addresses: ["203.0.113.10"] } : m.resolvePublicHost(host),
  };
});
vi.mock("@/lib/scanner/engine", async (orig) => {
  const m = await orig<typeof import("@/lib/scanner/engine")>();
  const fx = await import("./helpers/fixture-server");
  return { ...m, advanceScan: (id: string, deps: Parameters<typeof m.advanceScan>[1]) => m.advanceScan(id, { ...deps, fetchOverrides: { lookup: fx.fixtureLookup(), addressPolicy: fx.fixturePolicy } }) };
});

import * as accountRoute from "@/app/api/account/route";
import * as claimRoute from "@/app/api/account/claim/route";
import * as auditsRoute from "@/app/api/audits/route";
import * as sessionRoute from "@/app/api/auth/session/route";
import * as signInRoute from "@/app/api/auth/sign-in/route";
import * as signOutRoute from "@/app/api/auth/sign-out/route";
import * as dashboardRoute from "@/app/api/dashboard/route";
import * as orgsRoute from "@/app/api/organizations/route";
import * as orgRoute from "@/app/api/organizations/[orgId]/route";
import * as membersRoute from "@/app/api/organizations/[orgId]/members/route";
import * as memberRoute from "@/app/api/organizations/[orgId]/members/[userId]/route";
import * as invitationsRoute from "@/app/api/organizations/[orgId]/invitations/route";
import * as invitationRoute from "@/app/api/organizations/[orgId]/invitations/[invitationId]/route";
import * as recipientInvitationsRoute from "@/app/api/organizations/invitations/route";
import * as acceptInvitationRoute from "@/app/api/organizations/invitations/[invitationId]/accept/route";
import * as rejectInvitationRoute from "@/app/api/organizations/invitations/[invitationId]/reject/route";
import * as advanceRoute from "@/app/api/scans/[id]/advance/route";
import * as aiSummaryRoute from "@/app/api/scans/[id]/ai-summary/route";
import * as cancelRoute from "@/app/api/scans/[id]/cancel/route";
import * as findingsRoute from "@/app/api/scans/[id]/findings/route";
import * as findingDetailRoute from "@/app/api/scans/[id]/findings/[findingId]/route";
import * as linksRoute from "@/app/api/scans/[id]/links/route";
import * as pagesRoute from "@/app/api/scans/[id]/pages/route";
import * as pdfRoute from "@/app/api/scans/[id]/report.pdf/route";
import * as rerunRoute from "@/app/api/scans/[id]/rerun/route";
import * as resultsRoute from "@/app/api/scans/[id]/results/route";
import * as scanRoute from "@/app/api/scans/[id]/route";
import * as compareRoute from "@/app/api/scans/compare/route";
import * as scansRoute from "@/app/api/scans/route";
import * as usageRoute from "@/app/api/usage/route";
import * as callbackRoute from "@/app/auth/callback/route";
import { createScanJob } from "@/lib/scanner/engine";
import { MAX_ORGANIZATION_MEMBERS } from "@/lib/db/account-types";
import { emptyProfessionalData } from "@/lib/services/professional-profile";
import { __resetConfigForTests, getConfig } from "@/lib/config/env";
import { __resetRepositoryForTests, getRepository } from "@/lib/db";
import type { PostgresRepository } from "@/lib/db/postgres";
import { __resetRateLimitsForTests } from "@/lib/http/rate-limit";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server";
import { TestBrowser } from "./helpers/route-harness";

const SUPA_URL = process.env.TEST_SUPABASE_URL;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const DB = process.env.TEST_SUPABASE_DATABASE_URL;
const enabled = !!(SUPA_URL && ANON && SERVICE && DB);
const d = enabled ? describe : describe.skip;

const SAVED_ENV = { ...process.env };
const TERMINAL = ["completed", "completed_with_warnings", "failed", "cancelled"];
let srv: FixtureServer;
let target: string;
const created: string[] = [];

interface TestUser { id: string; email: string; password: string }

async function admin(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPA_URL}/auth/v1/admin${path}`, {
    ...init,
    headers: { apikey: SERVICE!, authorization: `Bearer ${SERVICE}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function makeUser(label: string): Promise<TestUser> {
  const email = `vt-${label}-${randomUUID().slice(0, 8)}@sitelens.localtest`;
  const password = `Vt-${randomUUID()}`;
  const r = await admin("/users", { method: "POST", body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: `VT ${label}` } }) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  created.push(r.body.id);
  return { id: r.body.id, email, password };
}

async function newInstance() {
  try {
    const old = getRepository();
    if (old.kind === "postgres") await (old as PostgresRepository).close();
  } catch {
    /* unconfigured */
  }
  __resetConfigForTests();
  __resetRepositoryForTests();
}

async function signIn(b: TestBrowser, u: TestUser) {
  const r = await b.call(signInRoute.POST, "POST", "/api/auth/sign-in", { json: { email: u.email, password: u.password } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r;
}
async function start(b: TestBrowser, idem?: string, maxPages?: number) {
  const json: { url: string; maxPages?: number } = { url: target };
  if (maxPages !== undefined) json.maxPages = maxPages;
  return b.call<{ id: string; status: string }>(scansRoute.POST, "POST", "/api/scans", { json, headers: idem ? { "idempotency-key": idem } : {} });
}
async function runToEnd(b: TestBrowser, id: string) {
  let status = "";
  for (let i = 0; i < 80 && !TERMINAL.includes(status); i++) {
    const r = await b.call<{ scan: { status: string } | null }>(advanceRoute.POST, "POST", `/api/scans/${id}/advance`, { params: { id }, json: {} });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    status = r.body.data?.scan?.status ?? status;
  }
  return status;
}
const getScan = (b: TestBrowser, id: string) => b.call<{ id: string; title: string | null; organizationId?: string | null; viewer?: { canEdit: boolean; viaOrganization?: boolean } }>(scanRoute.GET, "GET", `/api/scans/${id}`, { params: { id } });

beforeAll(async () => {
  if (!enabled) return;
  srv = await startFixtureServer();
  target = `http://site.sitelens-fixture.com:${srv.port}/`;
  for (const k of ["DATABASE_URL", "POSTGRES_URL", "VERCEL", "ALLOW_MEMORY_STORAGE", "AWS_LAMBDA_FUNCTION_NAME", "NETLIFY", "CRON_SECRET", "NEXT_PUBLIC_APP_URL"]) delete process.env[k];
  Object.assign(process.env, {
    DATABASE_URL: DB,
    DATABASE_SSL: "disable",
    NEXT_PUBLIC_SUPABASE_URL: SUPA_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ANON,
    SUPABASE_SECRET_KEY: SERVICE,
    SESSION_SECRET: "accounts-integration-test-secret-0123456789abcdef",
    SCAN_ALLOWED_PORTS: `${srv.port},80,443`,
    API_RATE_LIMIT_PER_MINUTE: "10000",
    BACKGROUND_PROCESSING: "false", // the test drives audits itself (deterministic)
    ANONYMOUS_AUDITS_ENABLED: "true",
    FREE_MAX_CONCURRENT_SCANS: "1",
    AUDIT_BURST_LIMIT: "50",
    FREE_SCANS_PER_WINDOW: "50",
  });
  await newInstance();
});
afterAll(async () => {
  if (!enabled) return;
  for (const id of created) await admin(`/users/${id}`, { method: "DELETE" }).catch(() => null);
  await newInstance();
  process.env = { ...SAVED_ENV };
  __resetConfigForTests();
  await srv?.close();
});
beforeEach(() => __resetRateLimitsForTests());

d("Supabase Auth sessions (real GoTrue)", () => {
  it("sign-in sets HttpOnly session cookies; the session survives a new server instance", async () => {
    const u = await makeUser("session");
    const b = new TestBrowser();
    await b.visit("/");
    const r = await signIn(b, u);
    const setCookies = r.headers.getSetCookie().filter((c) => /^sb-[^=]+-auth-token/.test(c));
    expect(setCookies.length).toBeGreaterThan(0);
    for (const c of setCookies) {
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=Lax/i);
    }
    expect(JSON.stringify(r.body)).not.toMatch(/access_token|refresh_token/);
    await newInstance();
    const s = await b.call<{ status: string; user: { id: string; email: string } | null }>(sessionRoute.GET, "GET", "/api/auth/session");
    expect(s.body.data!.status).toBe("signed_in");
    expect(s.body.data!.user!.id).toBe(u.id);
    expect(s.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("wrong password → 401 invalid_credentials, no cookies", async () => {
    const u = await makeUser("badpw");
    const b = new TestBrowser();
    const r = await b.call(signInRoute.POST, "POST", "/api/auth/sign-in", { json: { email: u.email, password: "not-the-password-1" } });
    expect(r.status).toBe(401);
    expect(r.body.error?.code).toBe("invalid_credentials");
    expect([...b.cookies.keys()].some((k) => k.startsWith("sb-"))).toBe(false);
  });

  it("a forged/expired session cookie is rejected server-side (401, never treated as signed in)", async () => {
    const u = await makeUser("forged");
    const b = new TestBrowser();
    await signIn(b, u);
    const name = [...b.cookies.keys()].find((k) => /^sb-.+-auth-token(\.0)?$/.test(k))!;
    expect(name).toBeTruthy();
    for (const k of [...b.cookies.keys()]) if (k.startsWith("sb-")) b.cookies.delete(k);
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: u.id, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, email: u.email })).toString("base64url");
    const forged = { access_token: `${header}.${payload}.${Buffer.from("not-a-real-signature").toString("base64url")}`, refresh_token: "forged-refresh", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: u.id, email: u.email } };
    b.cookies.set(name.replace(/\.0$/, ""), "base64-" + Buffer.from(JSON.stringify(forged)).toString("base64url"));
    const r = await b.call(dashboardRoute.GET, "GET", "/api/dashboard");
    expect(r.status).toBe(401);
    expect(["session_expired", "auth_required"]).toContain(r.body.error?.code);
    const s = await b.call<{ status: string; user: unknown }>(sessionRoute.GET, "GET", "/api/auth/session");
    expect(s.body.data!.user).toBeNull();
  });

  it("protected APIs require sign-in", async () => {
    const b = new TestBrowser();
    for (const [h, p] of [[dashboardRoute.GET, "/api/dashboard"], [auditsRoute.GET, "/api/audits"], [accountRoute.GET, "/api/account"]] as const) {
      const r = await b.call(h, "GET", p);
      expect(r.status, p).toBe(401);
      expect(r.body.error?.code).toBe("auth_required");
    }
  });

  it("OAuth callback: provider errors and missing codes redirect to sign-in on the same site", async () => {
    const b = new TestBrowser();
    const denied = await b.call(callbackRoute.GET, "GET", "/auth/callback?error=access_denied&error_description=User+denied&next=%2Fdashboard");
    expect([302, 307]).toContain(denied.status);
    const loc = new URL(denied.headers.get("location")!);
    expect(loc.host).toBe("sitelens.localtest");
    expect(loc.pathname).toBe("/sign-in");
    expect(loc.searchParams.get("error")).toBe("access_denied");
    const missing = await b.call(callbackRoute.GET, "GET", "/auth/callback?next=https%3A%2F%2Fevil.example%2Fsteal");
    const loc2 = new URL(missing.headers.get("location")!);
    expect(loc2.host).toBe("sitelens.localtest");
    expect(loc2.pathname).toBe("/sign-in");
    expect(loc2.searchParams.get("next") ?? "/").not.toMatch(/evil/);
    const bogus = await b.call(callbackRoute.GET, "GET", "/auth/callback?code=not-a-real-code");
    const loc3 = new URL(bogus.headers.get("location")!);
    expect(loc3.pathname).toBe("/sign-in");
    expect(loc3.searchParams.get("error")).toBeTruthy();
  });
});

d("professional profile Postgres persistence (real test database)", () => {
  it("round-trips services and portfolio with the same transactionally saved profile", async () => {
    const user = await makeUser("professional-profile");
    const repo = getRepository() as PostgresRepository;
    await repo.ensureProfile({ id: user.id, email: user.email, displayName: "Profile fixture" });
    const data = emptyProfessionalData();
    data.profile.profileType = "agency";
    data.profile.professionalName = "Test agency lead";
    data.profile.businessName = "Test agency";
    data.profile.headline = "Independent test profile";
    data.services = [0, 1].map((sortOrder) => ({
      id: randomUUID(),
      title: `Test service ${sortOrder + 1}`,
      description: "Disposable integration fixture",
      categories: ["seo"],
      keywords: [`test keyword ${sortOrder + 1}`],
      isPublic: sortOrder === 0,
      sortOrder,
    }));
    data.portfolio = [0, 1].map((sortOrder) => ({
      id: randomUUID(),
      title: `Test project ${sortOrder + 1}`,
      projectUrl: `https://portfolio${sortOrder + 1}.example.test/work`,
      description: "Disposable integration fixture",
      serviceIds: [data.services[sortOrder].id],
      categories: ["seo"],
      isPublic: true,
      sortOrder,
    }));

    await repo.saveProfessionalData(user.id, data);
    const loaded = await repo.getProfessionalData(user.id);
    expect(loaded.profile).toMatchObject({ profileType: "agency", businessName: "Test agency", professionalName: "Test agency lead" });
    expect(loaded.services.map((item) => item.title)).toEqual(["Test service 1", "Test service 2"]);
    expect(loaded.portfolio.map((item) => item.title)).toEqual(["Test project 1", "Test project 2"]);
    expect(loaded.portfolio.map((item) => item.serviceIds)).toEqual(data.services.map((service) => [service.id]));
  });
});

d("audit ownership, persistence and isolation (real auth)", () => {
  let a: TestUser;
  let bUser: TestUser;
  const A = new TestBrowser("A");
  const B = new TestBrowser("B");
  let auditId = "";

  beforeAll(async () => {
    a = await makeUser("owner");
    bUser = await makeUser("other");
  });

  it("A runs an audit; it is saved under A and reopens after sign-out/sign-in on a new instance", async () => {
    await A.visit("/");
    await signIn(A, a);
    const r = await start(A, `vt-${randomUUID()}`);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    auditId = r.body.data!.id;
    expect(["completed", "completed_with_warnings"]).toContain(await runToEnd(A, auditId));

    const out = await A.call(signOutRoute.POST, "POST", "/api/auth/sign-out", { json: {} });
    expect(out.status).toBe(200);
    expect([...A.cookies.keys()].some((k) => /^sb-.+-auth-token/.test(k))).toBe(false);
    expect((await getScan(A, auditId)).status).toBe(401); // sign-in is mandatory for all reports
    expect((await A.call(dashboardRoute.GET, "GET", "/api/dashboard")).status).toBe(401);

    await newInstance();
    await signIn(A, a);
    const again = await getScan(A, auditId);
    expect(again.status).toBe(200);
    const res = await A.call<{ pages: unknown[]; findings: unknown[] }>(resultsRoute.GET, "GET", `/api/scans/${auditId}/results`, { params: { id: auditId } });
    expect(res.status).toBe(200);
    expect(res.body.data!.pages.length).toBeGreaterThan(0);
    const dash = await A.call<{ stats: { total: number; completed: number } }>(dashboardRoute.GET, "GET", "/api/dashboard");
    expect(dash.status).toBe(200);
    expect(dash.body.data!.stats.total).toBe(1);
  });

  it("B guessing A's audit ID gets 404 on every read, write, export and compare", async () => {
    await B.visit("/");
    await signIn(B, bUser);
    const id = auditId;
    const p = { params: { id } };
    const checks: Array<[string, Promise<{ status: number; body: { error?: { code: string } } }>]> = [
      ["GET scan", B.call(scanRoute.GET, "GET", `/api/scans/${id}`, p)],
      ["results", B.call(resultsRoute.GET, "GET", `/api/scans/${id}/results`, p)],
      ["pages", B.call(pagesRoute.GET, "GET", `/api/scans/${id}/pages`, p)],
      ["links", B.call(linksRoute.GET, "GET", `/api/scans/${id}/links`, p)],
      ["findings", B.call(findingsRoute.GET, "GET", `/api/scans/${id}/findings`, p)],
      ["pdf", B.call(pdfRoute.GET, "GET", `/api/scans/${id}/report.pdf`, p)],
      ["rename", B.call(scanRoute.PATCH, "PATCH", `/api/scans/${id}`, { ...p, json: { title: "pwned" } })],
      ["delete", B.call(scanRoute.DELETE, "DELETE", `/api/scans/${id}`, p)],
      ["rerun", B.call(rerunRoute.POST, "POST", `/api/scans/${id}/rerun`, { ...p, json: {} })],
      ["cancel", B.call(cancelRoute.POST, "POST", `/api/scans/${id}/cancel`, { ...p, json: {} })],
      ["advance", B.call(advanceRoute.POST, "POST", `/api/scans/${id}/advance`, { ...p, json: {} })],
      ["compare", B.call(compareRoute.GET, "GET", `/api/scans/compare?a=${id}&b=${randomUUID()}`)],
      ["compare (other side)", B.call(compareRoute.GET, "GET", `/api/scans/compare?a=${randomUUID()}&b=${id}`)],
    ];
    for (const [name, pr] of checks) {
      const r = await pr;
      expect(r.status, name).toBe(404);
      expect(r.body.error?.code, name).toBe("not_found");
    }
    // A's data is untouched and invisible in B's lists and stats.
    const mine = await getScan(A, id);
    expect(mine.status).toBe(200);
    expect(mine.body.data!.title).not.toBe("pwned");
    const list = await B.call<{ items: Array<{ id: string }> }>(auditsRoute.GET, "GET", "/api/audits?scope=all");
    expect(list.body.data!.items.map((x) => x.id)).not.toContain(id);
    const dash = await B.call<{ stats: { total: number } }>(dashboardRoute.GET, "GET", "/api/dashboard");
    expect(dash.body.data!.stats.total).toBe(0);
  });

  it("private audits become explicitly readable to team members, and unshare/removal/deletion revoke access", async () => {
    const c = await makeUser("team-reader");
    const outsider = await makeUser("team-outsider");
    const C = new TestBrowser("C");
    const D = new TestBrowser("D");
    await C.visit("/"); await signIn(C, c);
    await D.visit("/"); await signIn(D, outsider);

    const org = await A.call<{ organization: { id: string; name: string } }>(orgsRoute.POST, "POST", "/api/organizations", { json: { name: `VT Team ${randomUUID().slice(0, 4)}` } });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    const orgId = org.body.data!.organization.id;
    expect((await getScan(B, auditId)).status).toBe(404); // a team membership alone does not expose a private audit
    expect((await getScan(D, auditId)).status).toBe(404);

    // Neither self-add nor owner direct-add can grant membership; the recipient accepts a persisted invitation.
    const self = await B.call(membersRoute.POST, "POST", `/api/organizations/${orgId}/members`, { params: { orgId }, json: { email: bUser.email, role: "owner" } });
    expect([403, 404]).toContain(self.status);
    const directAdd = await A.call(membersRoute.POST, "POST", `/api/organizations/${orgId}/members`, { params: { orgId }, json: { email: bUser.email, role: "member" } });
    expect(directAdd.status, JSON.stringify(directAdd.body)).toBe(410);
    expect(directAdd.body.error?.code).toBe("invitation_required");

    const inviteB = await A.call<{ invitation: { id: string; status: string; emailDeliveryStatus: string } }>(invitationsRoute.POST, "POST", `/api/organizations/${orgId}/invitations`, { params: { orgId }, json: { email: bUser.email, role: "member" } });
    expect(inviteB.status, JSON.stringify(inviteB.body)).toBe(201);
    expect(inviteB.body.data!.invitation.status).toBe("pending");
    expect(inviteB.body.data!.invitation.emailDeliveryStatus).toBe("not_configured");
    const managerView = await A.call<{ invitations: Array<{ id: string; emailDeliveryStatus: string; emailErrorCode: string | null }> }>(orgRoute.GET, "GET", `/api/organizations/${orgId}`, { params: { orgId } });
    expect(managerView.status).toBe(200);
    expect(managerView.body.data!.invitations).toContainEqual(expect.objectContaining({ id: inviteB.body.data!.invitation.id, emailDeliveryStatus: "not_configured", emailErrorCode: "email_not_configured" }));
    const beforeAcceptance = await A.call<{ members: Array<{ userId: string }> }>(membersRoute.GET, "GET", `/api/organizations/${orgId}/members`, { params: { orgId } });
    expect(beforeAcceptance.body.data!.members.map((member) => member.userId)).not.toContain(bUser.id);
    const inboxB = await B.call<{ invitations: Array<{ id: string; organizationName: string }> }>(recipientInvitationsRoute.GET, "GET", "/api/organizations/invitations");
    expect(inboxB.status).toBe(200);
    expect(inboxB.body.data!.invitations).toContainEqual(expect.objectContaining({ id: inviteB.body.data!.invitation.id, organizationName: org.body.data!.organization.name }));
    const acceptB = await B.call(acceptInvitationRoute.POST, "POST", `/api/organizations/invitations/${inviteB.body.data!.invitation.id}/accept`, { params: { invitationId: inviteB.body.data!.invitation.id }, json: {} });
    expect(acceptB.status, JSON.stringify(acceptB.body)).toBe(200);

    const inviteC = await A.call<{ invitation: { id: string; status: string } }>(invitationsRoute.POST, "POST", `/api/organizations/${orgId}/invitations`, { params: { orgId }, json: { email: c.email, role: "member" } });
    expect(inviteC.status, JSON.stringify(inviteC.body)).toBe(201);
    const inboxC = await C.call<{ invitations: Array<{ id: string }> }>(recipientInvitationsRoute.GET, "GET", "/api/organizations/invitations");
    expect(inboxC.body.data!.invitations).toContainEqual(expect.objectContaining({ id: inviteC.body.data!.invitation.id }));
    const wrongRecipient = await B.call(acceptInvitationRoute.POST, "POST", `/api/organizations/invitations/${inviteC.body.data!.invitation.id}/accept`, { params: { invitationId: inviteC.body.data!.invitation.id }, json: {} });
    expect(wrongRecipient.status).toBe(403);
    expect(wrongRecipient.body.error?.code).toBe("invitation_email_mismatch");
    const acceptC = await C.call(acceptInvitationRoute.POST, "POST", `/api/organizations/invitations/${inviteC.body.data!.invitation.id}/accept`, { params: { invitationId: inviteC.body.data!.invitation.id }, json: {} });
    expect(acceptC.status, JSON.stringify(acceptC.body)).toBe(200);

    const inviteD = await A.call<{ invitation: { id: string } }>(invitationsRoute.POST, "POST", `/api/organizations/${orgId}/invitations`, { params: { orgId }, json: { email: outsider.email, role: "member" } });
    expect(inviteD.status, JSON.stringify(inviteD.body)).toBe(201);
    const declineD = await D.call(rejectInvitationRoute.POST, "POST", `/api/organizations/invitations/${inviteD.body.data!.invitation.id}/reject`, { params: { invitationId: inviteD.body.data!.invitation.id }, json: {} });
    expect(declineD.status, JSON.stringify(declineD.body)).toBe(200);

    const revokedUser = await makeUser("team-revoked");
    const E = new TestBrowser("E");
    await E.visit("/"); await signIn(E, revokedUser);
    const inviteE = await A.call<{ invitation: { id: string } }>(invitationsRoute.POST, "POST", `/api/organizations/${orgId}/invitations`, { params: { orgId }, json: { email: revokedUser.email, role: "member" } });
    expect(inviteE.status, JSON.stringify(inviteE.body)).toBe(201);
    const revoked = await A.call(invitationRoute.DELETE, "DELETE", `/api/organizations/${orgId}/invitations/${inviteE.body.data!.invitation.id}`, { params: { orgId, invitationId: inviteE.body.data!.invitation.id } });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    const afterRevoke = await E.call(acceptInvitationRoute.POST, "POST", `/api/organizations/invitations/${inviteE.body.data!.invitation.id}/accept`, { params: { invitationId: inviteE.body.data!.invitation.id }, json: {} });
    expect(afterRevoke.status).toBe(409);

    const replayB = await B.call(acceptInvitationRoute.POST, "POST", `/api/organizations/invitations/${inviteB.body.data!.invitation.id}/accept`, { params: { invitationId: inviteB.body.data!.invitation.id }, json: {} });
    expect(replayB.status).toBe(409);
    const membersAfterResponses = await A.call<{ members: Array<{ userId: string }> }>(membersRoute.GET, "GET", `/api/organizations/${orgId}/members`, { params: { orgId } });
    expect(membersAfterResponses.body.data!.members.map((member) => member.userId)).toContain(bUser.id);
    expect(membersAfterResponses.body.data!.members.map((member) => member.userId)).toContain(c.id);
    expect(membersAfterResponses.body.data!.members.map((member) => member.userId)).not.toContain(outsider.id);
    expect(membersAfterResponses.body.data!.members.map((member) => member.userId)).not.toContain(revokedUser.id);
    expect((await getScan(B, auditId)).status).toBe(404); // explicit membership still does not expose a private audit

    const privateList = await B.call<{ items: Array<{ id: string }> }>(auditsRoute.GET, "GET", "/api/audits?scope=all");
    expect(privateList.body.data!.items.map((item) => item.id)).not.toContain(auditId);
    const share = await A.call(scanRoute.PATCH, "PATCH", `/api/scans/${auditId}`, { params: { id: auditId }, json: { organizationId: orgId, expectedOrganizationId: null } });
    expect(share.status, JSON.stringify(share.body)).toBe(200);

    const seen = await getScan(B, auditId);
    expect(seen.status).toBe(200);
    expect(seen.body.data!.viewer).toMatchObject({ canEdit: false, viaOrganization: true });
    expect((await getScan(C, auditId)).status).toBe(200);
    expect((await getScan(D, auditId)).status).toBe(404);
    const sharedList = await B.call<{ items: Array<{ id: string; mine: boolean }> }>(auditsRoute.GET, "GET", "/api/audits?scope=all");
    expect(sharedList.body.data!.items.find((item) => item.id === auditId)?.mine).toBe(false);

    const results = await B.call<{ findings: Array<{ id: string }>; pages: unknown[]; links: unknown[] }>(resultsRoute.GET, "GET", `/api/scans/${auditId}/results`, { params: { id: auditId } });
    expect(results.status, JSON.stringify(results.body)).toBe(200);
    expect(results.body.data!.pages.length).toBeGreaterThan(0);
    const findings = await B.call<{ findings: Array<{ id: string }> }>(findingsRoute.GET, "GET", `/api/scans/${auditId}/findings`, { params: { id: auditId } });
    expect(findings.status, JSON.stringify(findings.body)).toBe(200);
    const pageEvidence = await B.call(pagesRoute.GET, "GET", `/api/scans/${auditId}/pages?detail=full`, { params: { id: auditId } });
    expect(pageEvidence.status).toBe(200);
    const linkEvidence = await B.call(linksRoute.GET, "GET", `/api/scans/${auditId}/links`, { params: { id: auditId } });
    expect(linkEvidence.status).toBe(200);
    if (findings.body.data!.findings[0]) {
      const issue = await B.call(findingDetailRoute.GET, "GET", `/api/scans/${auditId}/findings/${findings.body.data!.findings[0].id}`, { params: { id: auditId, findingId: findings.body.data!.findings[0].id } });
      expect(issue.status).toBe(200);
    }

    const deleteAttempt = await B.call(scanRoute.DELETE, "DELETE", `/api/scans/${auditId}`, { params: { id: auditId } });
    expect([403, 404]).toContain(deleteAttempt.status);
    const renameAttempt = await B.call(scanRoute.PATCH, "PATCH", `/api/scans/${auditId}`, { params: { id: auditId }, json: { title: "pwned" } });
    expect(renameAttempt.status).toBe(404);
    const unshareAttempt = await B.call(scanRoute.PATCH, "PATCH", `/api/scans/${auditId}`, { params: { id: auditId }, json: { organizationId: null, expectedOrganizationId: orgId } });
    expect(unshareAttempt.status).toBe(404);

    const stale = await A.call(scanRoute.PATCH, "PATCH", `/api/scans/${auditId}`, { params: { id: auditId }, json: { organizationId: null, expectedOrganizationId: null } });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("audit_sharing_conflict");
    const unshare = await A.call(scanRoute.PATCH, "PATCH", `/api/scans/${auditId}`, { params: { id: auditId }, json: { organizationId: null, expectedOrganizationId: orgId } });
    expect(unshare.status, JSON.stringify(unshare.body)).toBe(200);
    expect((await getScan(B, auditId)).status).toBe(404);
    expect((await getScan(C, auditId)).status).toBe(404);
    expect((await getScan(A, auditId)).status).toBe(200);

    const reshare = await A.call(scanRoute.PATCH, "PATCH", `/api/scans/${auditId}`, { params: { id: auditId }, json: { organizationId: orgId, expectedOrganizationId: null } });
    expect(reshare.status, JSON.stringify(reshare.body)).toBe(200);
    const removed = await A.call(memberRoute.DELETE, "DELETE", `/api/organizations/${orgId}/members/${bUser.id}`, { params: { orgId, userId: bUser.id } });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await getScan(B, auditId)).status).toBe(404);
    expect((await getScan(C, auditId)).status).toBe(200);

    const del = await A.call(orgRoute.DELETE, "DELETE", `/api/organizations/${orgId}`, { params: { orgId } });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect((await getScan(C, auditId)).status).toBe(404);
    expect((await getScan(A, auditId)).status).toBe(200);
  });

  it("a database-expired invitation disappears from the recipient inbox and cannot be accepted", async () => {
    const owner = await makeUser("invite-expiry-owner");
    const recipient = await makeUser("invite-expiry-recipient");
    const O = new TestBrowser("invite-expiry-owner");
    const R = new TestBrowser("invite-expiry-recipient");
    await O.visit("/");
    await signIn(O, owner);
    await R.visit("/");
    await signIn(R, recipient);

    let orgId: string | undefined;
    try {
      const org = await O.call<{ organization: { id: string } }>(orgsRoute.POST, "POST", "/api/organizations", { json: { name: `VT Expiry ${randomUUID().slice(0, 6)}` } });
      orgId = org.body.data?.organization.id;
      expect(org.status).toBe(201);
      if (!orgId) throw new Error("Organization creation returned no id.");

      const invited = await O.call<{ invitation: { id: string; status: string } }>(invitationsRoute.POST, "POST", `/api/organizations/${orgId}/invitations`, {
        params: { orgId }, json: { email: recipient.email, role: "member" },
      });
      expect(invited.status).toBe(201);
      expect(invited.body.data!.invitation.status).toBe("pending");
      const invitationId = invited.body.data!.invitation.id;

      // Move both timestamps back while preserving the schema's expires_at > created_at constraint.
      const sql = postgres(DB!, { ssl: false, max: 1, prepare: false });
      try {
        await sql`UPDATE public.organization_invitations
          SET created_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
          WHERE id = ${invitationId}`;
      } finally {
        await sql.end({ timeout: 5 });
      }

      const managerView = await O.call<{ invitations: Array<{ id: string; status: string }> }>(orgRoute.GET, "GET", `/api/organizations/${orgId}`, { params: { orgId } });
      expect(managerView.status).toBe(200);
      expect(managerView.body.data!.invitations).toContainEqual(expect.objectContaining({ id: invitationId, status: "expired" }));

      const inbox = await R.call<{ invitations: Array<{ id: string }> }>(recipientInvitationsRoute.GET, "GET", "/api/organizations/invitations");
      expect(inbox.status).toBe(200);
      expect(inbox.body.data!.invitations.map((item) => item.id)).not.toContain(invitationId);

      const accept = await R.call(acceptInvitationRoute.POST, "POST", `/api/organizations/invitations/${invitationId}/accept`, { params: { invitationId }, json: {} });
      expect(accept.status).toBe(410);
      expect(accept.body.error?.code).toBe("invitation_expired");
      const after = await O.call<{ invitations: Array<{ id: string; status: string }> }>(orgRoute.GET, "GET", `/api/organizations/${orgId}`, { params: { orgId } });
      expect(after.body.data!.invitations).toContainEqual(expect.objectContaining({ id: invitationId, status: "expired" }));
    } finally {
      if (orgId) {
        __resetRateLimitsForTests();
        await O.call(orgRoute.DELETE, "DELETE", `/api/organizations/${orgId}`, { params: { orgId } });
      }
    }
  });

  it("serializes concurrent invitation creation against the real Postgres member-capacity limit", async () => {
    expect(MAX_ORGANIZATION_MEMBERS).toBeGreaterThan(2);
    const owner = await makeUser("invite-capacity-owner");
    const O = new TestBrowser("invite-capacity-owner");
    await O.visit("/");
    await signIn(O, owner);

    let orgId: string | undefined;
    try {
      const org = await O.call<{ organization: { id: string } }>(orgsRoute.POST, "POST", "/api/organizations", { json: { name: `VT Capacity ${randomUUID().slice(0, 6)}` } });
      orgId = org.body.data?.organization.id;
      expect(org.status).toBe(201);
      if (!orgId) throw new Error("Organization creation returned no id.");

      const prefillCount = MAX_ORGANIZATION_MEMBERS - 2; // owner + invites leaves exactly one slot
      for (let i = 0; i < prefillCount; i++) {
        __resetRateLimitsForTests();
        const email = `vt-capacity-fill-${i}-${randomUUID().slice(0, 8)}@sitelens.localtest`;
        const response = await O.call(invitationsRoute.POST, "POST", `/api/organizations/${orgId}/invitations`, {
          params: { orgId }, json: { email, role: "member" },
        });
        expect(response.status).toBe(201);
      }

      const membersBefore = await O.call<{ members: Array<{ userId: string }> }>(membersRoute.GET, "GET", `/api/organizations/${orgId}/members`, { params: { orgId } });
      expect(membersBefore.status).toBe(200);
      expect(membersBefore.body.data!.members).toHaveLength(1);
      const invitationsBefore = await O.call<{ invitations: Array<{ status: string }> }>(orgRoute.GET, "GET", `/api/organizations/${orgId}`, { params: { orgId } });
      expect(invitationsBefore.body.data!.invitations.filter((invite) => invite.status === "pending")).toHaveLength(prefillCount);

      __resetRateLimitsForTests();
      const contenders = [1, 2].map((n) => `vt-capacity-race-${n}-${randomUUID()}@sitelens.localtest`);
      const results = await Promise.all(contenders.map((email) => O.call(invitationsRoute.POST, "POST", `/api/organizations/${orgId}/invitations`, {
        params: { orgId: orgId! }, json: { email, role: "member" },
      })));
      expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([201, 409]);
      expect(results.find((result) => result.status === 409)?.body.error?.code).toBe("member_limit");

      const invitationsAfter = await O.call<{ invitations: Array<{ status: string }> }>(orgRoute.GET, "GET", `/api/organizations/${orgId}`, { params: { orgId } });
      const pendingAfter = invitationsAfter.body.data!.invitations.filter((invite) => invite.status === "pending").length;
      expect(pendingAfter).toBe(prefillCount + 1);
      expect(pendingAfter + membersBefore.body.data!.members.length).toBe(MAX_ORGANIZATION_MEMBERS);
    } finally {
      if (orgId) {
        __resetRateLimitsForTests();
        await O.call(orgRoute.DELETE, "DELETE", `/api/organizations/${orgId}`, { params: { orgId } });
      }
    }
  });

  it("rejects client-supplied ownership, organization and plan fields; audit ownership and sharing remain isolated", async () => {
    const f = await makeUser("forger");
    const v = await makeUser("victim");
    const F = new TestBrowser("F");
    const V = new TestBrowser("V");
    await signIn(F, f);
    await signIn(V, v);

    let victimOrg: string | undefined;
    try {
      const org = await V.call<{ organization: { id: string } }>(orgsRoute.POST, "POST", "/api/organizations", { json: { name: `VT Victim ${randomUUID().slice(0, 4)}` } });
      expect(org.status, JSON.stringify(org.body)).toBe(201);
      victimOrg = org.body.data!.organization.id;

      // The start route intentionally rejects unknown keys rather than silently stripping them.
      const forged = await F.call(scansRoute.POST, "POST", "/api/scans", {
        json: { url: target, ownerId: v.id, owner_id: v.id, principalId: `user:${v.id}`, userId: v.id, organizationId: victimOrg, plan: "pro", planId: "pro", limits: { maxPages: 5000 } },
        headers: { "x-sitelens-plan": "pro", "x-user-id": v.id, "x-principal-id": `user:${v.id}` },
      });
      expect(forged.status, JSON.stringify(forged.body)).toBe(400);
      expect(forged.body.error?.code).toBe("validation_error");

      // Rejected input has no audit or usage side effects.
      const forgedList = await F.call<{ items: Array<{ id: string }> }>(auditsRoute.GET, "GET", "/api/audits");
      expect(forgedList.body.data!.items).toHaveLength(0);
      const fUsageBefore = await F.call<{ usage: { scans: { used: number } } }>(usageRoute.GET, "GET", "/api/usage");
      expect(fUsageBefore.body.data!.usage.scans.used).toBe(0);
      const vUsageBefore = await V.call<{ usage: { scans: { used: number } } }>(usageRoute.GET, "GET", "/api/usage");
      expect(vUsageBefore.body.data!.usage.scans.used).toBe(0);

      // Header spoofing alone cannot change the authenticated owner, plan or limits.
      const accepted = await F.call<{ id: string; organizationId: string | null; ownedByAccount: boolean; limits: { maxPages: number } }>(scansRoute.POST, "POST", "/api/scans", {
        json: { url: target },
        headers: { "x-sitelens-plan": "pro", "x-user-id": v.id, "x-principal-id": `user:${v.id}` },
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
      const id = accepted.body.data!.id;
      expect(accepted.body.data!.organizationId).toBeNull();
      expect(accepted.body.data!.ownedByAccount).toBe(true);
      expect(accepted.body.data!.limits.maxPages).toBeLessThanOrEqual(25);

      // Owned by the forger, invisible to the victim and the victim's organization.
      expect((await getScan(F, id)).body.data?.viewer?.canEdit).toBe(true);
      expect((await getScan(V, id)).status).toBe(404);
      const vList = await V.call<{ items: Array<{ id: string }> }>(auditsRoute.GET, "GET", "/api/audits");
      expect(vList.body.data!.items.map((x) => x.id)).not.toContain(id);
      const vUsage = await V.call<{ usage: { scans: { used: number } } }>(usageRoute.GET, "GET", "/api/usage");
      expect(vUsage.body.data!.usage.scans.used).toBe(0);

      // The plan comes from the verified server-side subscription, not client headers.
      const fUsage = await F.call<{ plan: { id: string; billingAvailable: boolean }; usage: { scans: { used: number } } }>(usageRoute.GET, "GET", "/api/usage", { headers: { "x-sitelens-plan": "pro" } });
      expect(fUsage.body.data!.plan.id).toBe("free");
      expect(fUsage.body.data!.usage.scans.used).toBe(1);

      // Sharing into an organization the forger doesn't belong to is refused, and nothing leaks.
      const share = await F.call(scanRoute.PATCH, "PATCH", `/api/scans/${id}`, { params: { id }, json: { organizationId: victimOrg, expectedOrganizationId: null } });
      expect([403, 404]).toContain(share.status);
      expect((await getScan(F, id)).body.data?.organizationId).toBeNull();
      expect((await getScan(V, id)).status).toBe(404);

      await F.call(cancelRoute.POST, "POST", `/api/scans/${id}/cancel`, { params: { id }, json: {} });
    } finally {
      if (victimOrg) {
        __resetRateLimitsForTests();
        await V.call(orgRoute.DELETE, "DELETE", `/api/organizations/${victimOrg}`, { params: { orgId: victimOrg } });
      }
    }
  });

  it("concurrent starts with DIFFERENT idempotency keys respect the plan's concurrency and refund rejected reservations", async () => {
    const c = await makeUser("race");
    const C = new TestBrowser("C");
    await signIn(C, c);
    // Keep all three requests affordable on Free so the race tests concurrency, not the 402 credit preflight.
    const pageLimit = 1;
    const oneAuditReserve = getConfig().plans.costs.auditStart + getConfig().plans.costs.perPage * pageLimit;
    const rs = await Promise.all([
      start(C, `k1-${randomUUID()}`, pageLimit),
      start(C, `k2-${randomUUID()}`, pageLimit),
      start(C, `k3-${randomUUID()}`, pageLimit),
    ]);
    const statuses = rs.map((r) => r.status).sort();
    expect(statuses, JSON.stringify(rs.map((r) => r.body.error))).toEqual([201, 429, 429]);
    for (const r of rs.filter((x) => x.status === 429)) expect(r.body.error?.code).toBe("concurrent_scan_limit");
    const usage = await C.call<{ usage: { scans: { used: number } } }>(usageRoute.GET, "GET", "/api/usage");
    expect(usage.body.data!.usage.scans.used).toBe(1);
    const list = await C.call<{ items: unknown[] }>(auditsRoute.GET, "GET", "/api/audits");
    expect(list.body.data!.items).toHaveLength(1);
    const credits = await getRepository().commerce.getCreditAccount(`user:${c.id}`);
    expect(credits).not.toBeNull();
    expect(credits!.balance).toBe(credits!.allowance - oneAuditReserve);
  });

  it("legacy anonymous records can be claimed only by their original browser after sign-in", async () => {
    const u = await makeUser("claim");
    const anon = new TestBrowser("anon");
    await anon.visit("/");
    const refused = await start(anon);
    expect(refused.status).toBe(401); // no NEW anonymous jobs, ever
    // Seed a pre-update record to retain the existing, explicit legacy-claim migration path.
    const principalId = anon.cookies.get("sl_pid")!;
    const repo = getRepository();
    await repo.ensurePrincipal(principalId, "local-fixture");
    const job = createScanJob({ principalId, websiteId: null, targetUrl: target, limits: getConfig().scanner });
    await repo.createScan(job);
    const anonId = job.id;
    // Another signed-in user can only claim ITS OWN browser's anonymous audits — never this one.
    const thief = await B.call<{ moved: number }>(claimRoute.POST, "POST", "/api/account/claim", { json: {} });
    if (thief.status === 200) expect(thief.body.data!.moved).toBe(0);
    else expect(thief.body.error?.code).toBe("nothing_to_claim");
    expect((await getScan(B, anonId)).status).toBe(404);
    await signIn(anon, u);
    const claim = await anon.call<{ moved: number }>(claimRoute.POST, "POST", "/api/account/claim", { json: {} });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    expect(claim.body.data!.moved).toBeGreaterThanOrEqual(1);
    const list = await anon.call<{ items: Array<{ id: string }> }>(auditsRoute.GET, "GET", "/api/audits");
    expect(list.body.data!.items.map((x) => x.id)).toContain(anonId);
    expect((await getScan(B, anonId)).status).toBe(404);
  });

  it("account deletion requires the typed email and removes the user's audits", async () => {
    const wrong = await A.call(accountRoute.DELETE, "DELETE", "/api/account", { json: { confirmEmail: "someone@else.example" } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error?.code).toBe("confirmation_mismatch");
    const ok = await A.call(accountRoute.DELETE, "DELETE", "/api/account", { json: { confirmEmail: a.email } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await admin(`/users/${a.id}`)).status).toBe(404);
    const again = await A.call(signInRoute.POST, "POST", "/api/auth/sign-in", { json: { email: a.email, password: a.password } });
    expect(again.status).toBe(401);
    const repo = getRepository() as PostgresRepository;
    expect(await repo.getScan(auditId)).toBeNull();
  });
});

d("server-enforced limits (real auth + Postgres)", () => {
  /** Runs `fn` with extra env on a fresh server instance, then restores the suite's env. */
  async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
    const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    await newInstance();
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await newInstance();
    }
  }
  type Err = { code: string; details?: { resetAt?: string; limit?: number } };
  const futureIso = (v: unknown) => typeof v === "string" && Date.parse(v) > Date.now();
  const cancel = (b: TestBrowser, id: string) => b.call(cancelRoute.POST, "POST", `/api/scans/${id}/cancel`, { params: { id }, json: {} });

  it("with ANONYMOUS_AUDITS_ENABLED=false, signed-out visitors can't start audits (signed-in users can)", async () => {
    await withEnv({ ANONYMOUS_AUDITS_ENABLED: "false" }, async () => {
      const anon = new TestBrowser("anon-off");
      const r = await start(anon);
      expect(r.status).toBe(401);
      expect((r.body.error as Err | undefined)?.code).toBe("auth_required");
      const u = await makeUser("anon-off");
      const U = new TestBrowser("U");
      await signIn(U, u);
      const okStart = await start(U);
      expect(okStart.status, JSON.stringify(okStart.body)).toBe(201);
      await cancel(U, okStart.body.data!.id);
    });
  });

  it("audit burst limit: an affordable third start is refused with a reset time and isn't charged", async () => {
    await withEnv({ PLAN_FREE_CREDITS: "100", AUDIT_BURST_LIMIT: "2", FREE_MAX_CONCURRENT_SCANS: "10", FREE_SCANS_PER_WINDOW: "50" }, async () => {
      const u = await makeUser("burst");
      const U = new TestBrowser("U");
      await signIn(U, u);
      const pageLimit = 1; // Three one-page reservations fit within Free's 100-credit allowance.
      const oneAuditReserve = getConfig().plans.costs.auditStart + getConfig().plans.costs.perPage * pageLimit;
      const rs = [];
      for (let i = 0; i < 3; i++) rs.push(await start(U, `burst-${i}-${randomUUID()}`, pageLimit));
      expect(rs.map((r) => r.status)).toEqual([201, 201, 429]);
      const err = rs[2].body.error as Err;
      expect(err.code).toBe("scan_burst_limited");
      expect(futureIso(err.details?.resetAt)).toBe(true);
      const usage = await U.call<{ usage: { scans: { used: number } } }>(usageRoute.GET, "GET", "/api/usage");
      expect(usage.body.data!.usage.scans.used).toBe(2);
      const credits = await getRepository().commerce.getCreditAccount(`user:${u.id}`);
      expect(credits).not.toBeNull();
      expect(credits!.balance).toBe(credits!.allowance - 2 * oneAuditReserve);
      for (const r of rs.slice(0, 2)) await cancel(U, r.body.data!.id);
    });
  });

  it("insufficient audit credits return 402 before metering and do not consume the scan allowance", async () => {
    await withEnv({
      PLAN_FREE_CREDITS: "22",
      CREDIT_COST_AUDIT_START: "10",
      CREDIT_COST_PAGE: "1",
      AUDIT_BURST_LIMIT: "50",
      FREE_MAX_CONCURRENT_SCANS: "10",
      FREE_SCANS_PER_WINDOW: "50",
    }, async () => {
      const u = await makeUser("credit-preflight");
      const U = new TestBrowser("U");
      await signIn(U, u);
      const pageLimit = 1;
      const oneAuditReserve = getConfig().plans.costs.auditStart + getConfig().plans.costs.perPage * pageLimit;
      expect(getConfig().plans.plans.free.monthlyCredits).toBe(2 * oneAuditReserve);

      const first = await start(U, `credit-1-${randomUUID()}`, pageLimit);
      const second = await start(U, `credit-2-${randomUUID()}`, pageLimit);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(second.status, JSON.stringify(second.body)).toBe(201);
      const third = await start(U, `credit-3-${randomUUID()}`, pageLimit);
      expect(third.status).toBe(402);
      expect(third.body.error?.code).toBe("insufficient_credits");

      const usage = await U.call<{ usage: { scans: { used: number } } }>(usageRoute.GET, "GET", "/api/usage");
      expect(usage.body.data!.usage.scans.used).toBe(2);
      const audits = await U.call<{ items: unknown[] }>(auditsRoute.GET, "GET", "/api/audits");
      expect(audits.body.data!.items).toHaveLength(2);
      const credits = await getRepository().commerce.getCreditAccount(`user:${u.id}`);
      expect(credits).not.toBeNull();
      expect(credits!.balance).toBe(0);

      await cancel(U, first.body.data!.id);
      await cancel(U, second.body.data!.id);
    });
  });

  it("plan audit limit: once used up, starts are refused with the limit and reset time", async () => {
    await withEnv({ FREE_SCANS_PER_WINDOW: "1", FREE_MAX_CONCURRENT_SCANS: "10", AUDIT_BURST_LIMIT: "50" }, async () => {
      const u = await makeUser("quota");
      const U = new TestBrowser("U");
      await signIn(U, u);
      const first = await start(U);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const second = await start(U);
      expect(second.status).toBe(429);
      const err = second.body.error as Err;
      expect(err.code).toBe("scan_limit_reached");
      expect(err.details?.limit).toBe(1);
      expect(futureIso(err.details?.resetAt)).toBe(true);
      const usage = await U.call<{ usage: { scans: { used: number; remaining: number; resetAt: string | null } } }>(usageRoute.GET, "GET", "/api/usage");
      expect(usage.body.data!.usage.scans).toMatchObject({ used: 1, remaining: 0 });
      expect(futureIso(usage.body.data!.usage.scans.resetAt)).toBe(true);
      await cancel(U, first.body.data!.id);
    });
  });

  it("Free AI stays unavailable; Pro AI requests honor burst and plan limits", async () => {
    const u = await makeUser("ai");
    const U = new TestBrowser("U");
    await signIn(U, u);
    const s0 = await start(U);
    expect(s0.status, JSON.stringify(s0.body)).toBe(201);
    const id = s0.body.data!.id;
    expect(TERMINAL).toContain(await runToEnd(U, id));

    const summary = { overview: "Stubbed summary for the limits test.", keyRisks: [], priorities: [], quickWins: [], limitations: "" };
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://openrouter.ai/")) {
        calls.push(url);
        return new Response(JSON.stringify({ model: "stub/model", choices: [{ message: { content: JSON.stringify(summary) }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    });
    const ask = () => U.call<{ cached: boolean }>(aiSummaryRoute.POST, "POST", `/api/scans/${id}/ai-summary`, { params: { id }, json: { regenerate: true } });
    const providerEnv = { OPENROUTER_API_KEY: "sk-or-v1-limits-test-only-000000", AI_PROVIDER: "openrouter" };
    try {
      // Verify the intended Free-plan gate directly; the legacy FREE_AI_* cap cannot grant the feature.
      await withEnv({ ...providerEnv, FREE_AI_REQUESTS_PER_WINDOW: "30" }, async () => {
        const repo = getRepository();
        const before = await repo.commerce.getCreditAccount(`user:${u.id}`);
        const denied = await ask();
        expect(denied.status).toBe(403);
        expect(denied.body.error?.code).toBe("plan_feature_unavailable");
        expect(denied.body.error?.details).toMatchObject({ feature: "aiSummary", requiredPlan: "pro" });
        const after = await getRepository().commerce.getCreditAccount(`user:${u.id}`);
        expect(after?.balance).toBe(before?.balance);
      });
      expect(calls).toHaveLength(0);

      // This synthetic, local-only billing event exercises the real subscription-derived Pro entitlement path.
      const now = new Date();
      const applied = await (getRepository() as PostgresRepository).applyBillingEvent({
        provider: "testpay",
        eventId: `vt-ai-${randomUUID()}`,
        type: "subscription.activated",
        occurredAt: now,
        userId: u.id,
        subscriptionRef: `vt-ai-sub-${randomUUID()}`,
        planId: "pro",
        periodStart: new Date(now.getTime() - 1000),
        periodEnd: new Date(now.getTime() + 30 * 86_400_000),
      });
      expect(applied.outcome).toBe("applied");

      await withEnv({ ...providerEnv, AI_BURST_LIMIT: "2", PLAN_PRO_AI_PER_DAY: "100" }, async () => {
        const effectivePlan = await U.call<{ plan: { id: string } }>(usageRoute.GET, "GET", "/api/usage");
        expect(effectivePlan.body.data!.plan.id).toBe("pro");
        const rs = [await ask(), await ask(), await ask()];
        expect(rs.map((r) => r.status), JSON.stringify(rs.map((r) => r.body.error))).toEqual([200, 200, 429]);
        expect((rs[2].body.error as Err).code).toBe("ai_burst_limited");
        expect(futureIso((rs[2].body.error as Err).details?.resetAt)).toBe(true);
        const credits = await getRepository().commerce.getCreditAccount(`user:${u.id}`);
        const aiCost = getConfig().plans.costs.aiRequest;
        expect(credits?.balance).toBe(getConfig().plans.plans.pro.monthlyCredits - 2 * aiCost);
      });
      expect(calls).toHaveLength(2); // the refused burst request never reached the provider

      await withEnv({ ...providerEnv, AI_BURST_LIMIT: "100", PLAN_PRO_AI_PER_DAY: "3" }, async () => {
        const effectivePlan = await U.call<{ plan: { id: string } }>(usageRoute.GET, "GET", "/api/usage");
        expect(effectivePlan.body.data!.plan.id).toBe("pro");
        const third = await ask();
        expect(third.status, JSON.stringify(third.body.error)).toBe(200);
        const fourth = await ask();
        expect(fourth.status).toBe(429);
        expect((fourth.body.error as Err).code).toBe("ai_limit_reached");
        expect((fourth.body.error as Err).details?.limit).toBe(3);
        const credits = await getRepository().commerce.getCreditAccount(`user:${u.id}`);
        const aiCost = getConfig().plans.costs.aiRequest;
        expect(credits?.balance).toBe(getConfig().plans.plans.pro.monthlyCredits - 3 * aiCost);
      });
      expect(calls).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);
});

describe("accounts integration prerequisites", () => {
  it.skipIf(enabled)("skipped: set TEST_SUPABASE_URL, TEST_SUPABASE_ANON_KEY, TEST_SUPABASE_SERVICE_ROLE_KEY and TEST_SUPABASE_DATABASE_URL to run", () => {
    expect(enabled).toBe(false);
  });
});
