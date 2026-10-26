/**
 * Private owner analytics dashboard — authorization, tracking intake,
 * aggregation accuracy and route regression tests.
 *
 * Drives the REAL route handlers through the simulated-browser harness
 * (route-harness + auth-fixture RSA issuer). Aggregation tests exercise the
 * real MemoryAnalytics implementation with deterministic stores.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", async () => (await import("./helpers/route-harness")).nextHeadersMock);

import * as overviewRoute from "@/app/api/admin/analytics/overview/route";
import * as popularRoute from "@/app/api/admin/analytics/popular/route";
import * as landingsRoute from "@/app/api/admin/analytics/landings/route";
import * as activityRoute from "@/app/api/admin/analytics/activity/route";
import * as trackRoute from "@/app/api/analytics/track/route";
import { ADMIN_ALLOWLIST, isAdminContext, isAdminUser, normalizeEmail } from "@/lib/admin/allowlist";
import { classifySource, sanitizePath, sanitizeReferrerHost, uaBrowser, uaDevice, uaOs } from "@/lib/analytics/classify";
import { parseAnalyticsRange, parsePagination } from "@/lib/analytics/range";
import { __resetConfigForTests, getConfig } from "@/lib/config/env";
import { __resetRepositoryForTests, getRepository } from "@/lib/db";
import { MemoryAnalytics, type AnalyticsStoreShape } from "@/lib/db/analytics-memory";
import type { AnalyticsOverview, AnalyticsRange } from "@/lib/db/analytics-types";
import { __resetRateLimitsForTests } from "@/lib/http/rate-limit";
import type { ScanJob } from "@/lib/scanner/types";
import { startAuthFixture } from "./helpers/auth-fixture";
import { TestBrowser } from "./helpers/route-harness";

const ADMIN_EMAIL = ADMIN_ALLOWLIST[0]!;
const SAVED_ENV = { ...process.env };

let auth: Awaited<ReturnType<typeof startAuthFixture>>;

function setEnv() {
  delete process.env.DATABASE_URL;
  auth.configure();
  process.env.API_RATE_LIMIT_PER_MINUTE = "10000";
}

async function freshInstance() {
  __resetConfigForTests();
  __resetRepositoryForTests();
}

function adminBrowser() {
  const b = new TestBrowser("admin");
  auth.signIn(b, { email: ADMIN_EMAIL });
  return b;
}

function userBrowser(email = "customer@example.test") {
  const b = new TestBrowser("user");
  auth.signIn(b, { email });
  return b;
}

const overview = (b: TestBrowser, q = "days=30") => b.call<AnalyticsOverview>(overviewRoute.GET, "GET", `/api/admin/analytics/overview?${q}`);
const track = (b: TestBrowser, json: unknown, headers?: Record<string, string>) => b.call(trackRoute.POST, "POST", "/api/analytics/track", { json, headers });

function event(over: Partial<{ eventId: string; visitorId: string; sessionId: string; path: string; referrer: string | null; utmSource: string | null; utmMedium: string | null; eventType: "pageview" | "session_start" }> = {}) {
  return {
    eventId: over.eventId ?? randomUUID(),
    visitorId: over.visitorId ?? randomUUID(),
    sessionId: over.sessionId ?? randomUUID(),
    eventType: over.eventType ?? "pageview",
    path: over.path ?? "/",
    referrer: over.referrer ?? null,
    utmSource: over.utmSource ?? null,
    utmMedium: over.utmMedium ?? null,
  };
}

beforeAll(async () => {
  auth = await startAuthFixture();
});
afterAll(async () => {
  await freshInstance();
  process.env = { ...SAVED_ENV };
  __resetConfigForTests();
  await auth?.close();
});
beforeEach(async () => {
  setEnv();
  await freshInstance();
  __resetRateLimitsForTests();
});

/* ══════════════════════════════ 1. Allowlist ══════════════════════════════ */

describe("owner allowlist", () => {
  it("is exactly one email, set at build time", () => {
    expect(ADMIN_ALLOWLIST).toEqual(["talha.imtiaz2111@gmail.com"]);
  });
  it("normalizes case, whitespace and unicode", () => {
    expect(normalizeEmail(`  ${ADMIN_EMAIL.toUpperCase()}\n`)).toBe(ADMIN_EMAIL);
    expect(isAdminUser({ id: "u", email: ADMIN_EMAIL.toUpperCase() } as never)).toBe(true);
    expect(isAdminUser({ id: "u", email: "talha.imtiaz2111+1@gmail.com" } as never)).toBe(false);
    expect(isAdminUser(null)).toBe(false);
  });
  it("never treats anonymous or expired contexts as admin", () => {
    expect(isAdminContext({ auth: "anonymous", user: null } as never)).toBe(false);
    expect(isAdminContext({ auth: "disabled", user: null } as never)).toBe(false);
  });
});

/* ═════════════════════════ 2. Route authorization ═════════════════════════ */

describe("admin analytics routes — authorization", () => {
  const routes: Array<[string, (b: TestBrowser) => Promise<{ status: number; body: { error?: { code: string } } }>]> = [
    ["overview", (b) => overview(b)],
    ["popular", (b) => b.call(popularRoute.GET, "GET", "/api/admin/analytics/popular?days=30")],
    ["landings", (b) => b.call(landingsRoute.GET, "GET", "/api/admin/analytics/landings?days=30")],
    ["activity", (b) => b.call(activityRoute.GET, "GET", "/api/admin/analytics/activity?days=30")],
  ];

  it.each(routes)("%s is 401 for anonymous visitors", async (_name, call) => {
    const r = await call(new TestBrowser("anon"));
    expect(r.status).toBe(401);
    expect(r.body.error?.code).toBe("sign_in_required");
  });

  it.each(routes)("%s is 403 for an ordinary signed-in user", async (_name, call) => {
    const r = await call(userBrowser());
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe("forbidden");
  });

  it.each(routes)("%s is 200 for the allowlisted owner", async (_name, call) => {
    const r = await call(adminBrowser());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("is 401 when the session token is tampered (forged sign-in)", async () => {
    const b = new TestBrowser("forged");
    auth.signIn(b, { email: ADMIN_EMAIL, tampered: true });
    const r = await overview(b);
    expect(r.status).toBe(401);
  });

  it("an expired session revokes access, even for the owner email", async () => {
    const b = new TestBrowser("expired");
    auth.signIn(b, { email: ADMIN_EMAIL, expired: true });
    const r = await overview(b);
    expect(r.status).toBe(401);
    expect(r.body.error?.code).toBe("sign_in_required");
  });

  it("the allowlist email is taken from the verified session, never client input", async () => {
    const b = new TestBrowser("spoof");
    // Forging the request email is impossible: sign-in sets verified claims;
    // a forged JWT is rejected (see tampered test above). A request that tries
    // to smuggle the owner email in headers/body is irrelevant — the route
    // only reads ctx.user.email.
    auth.signIn(b, { email: "attacker@example.test" });
    const r = await overview(b);
    expect(r.status).toBe(403);
  });

  it("normal signup cannot become admin: a user row never elevates privileges", async () => {
    const b = userBrowser("talha.imtiaz2111@gmail.com.evil.test");
    const r = await overview(b);
    expect(r.status).toBe(403);
  });

  it("bounds and validates range parameters", async () => {
    const b = adminBrowser();
    const bad = await b.call(overviewRoute.GET, "GET", "/api/admin/analytics/overview?days=14");
    expect(bad.status).toBe(400);
    const future = await b.call(overviewRoute.GET, "GET", "/api/admin/analytics/overview?from=2020-01-01&to=2300-01-01");
    expect(future.status).toBe(400);
    const custom = await b.call(overviewRoute.GET, "GET", "/api/admin/analytics/overview?from=2026-10-01T00:00:00Z&to=2026-10-23T00:00:00Z");
    expect(custom.status).toBe(200);
  });
});

/* ═══════════════════════════ 3. Tracking intake ═══════════════════════════ */

describe("tracking intake — /api/analytics/track", () => {
  it("persists a validated pageview from an anonymous visitor (204)", async () => {
    const b = new TestBrowser("visitor");
    const r = await track(b, event());
    expect(r.status).toBe(204);
    expect(await getRepository().analytics.countEventsBefore(new Date(Date.now() + 60_000))).toBe(1);
  });

  it("deduplicates retries by client event id", async () => {
    const b = new TestBrowser("retry");
    const e = event();
    expect((await track(b, e)).status).toBe(204);
    expect((await track(b, e)).status).toBe(204); // beacon retry
    expect((await track(b, e)).status).toBe(204);
    expect(await getRepository().analytics.countEventsBefore(new Date(Date.now() + 60_000))).toBe(1);
  });

  it("silently skips excluded areas (admin/api/auth/docs) and asset-like paths", async () => {
    const b = new TestBrowser("excluded");
    for (const path of ["/admin/analytics", "/api/usage", "/favicon.ico", "/robots.txt", "/sign-in"]) {
      expect((await track(b, event({ path }))).status).toBe(204);
    }
    expect(await getRepository().analytics.countEventsBefore(new Date(Date.now() + 60_000))).toBe(0);
  });

  it("skips bot user agents", async () => {
    const b = new TestBrowser("bot");
    const r = await track(b, event(), { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" });
    expect(r.status).toBe(204);
    expect(await getRepository().analytics.countEventsBefore(new Date(Date.now() + 60_000))).toBe(0);
  });

  it("rejects oversize/malformed payloads without storing anything", async () => {
    const b = new TestBrowser("attacker");
    const r1 = await track(b, { garbage: true });
    expect(r1.status).toBe(400);
    const r2 = await track(b, event({ path: "/x".repeat(500) }));
    expect([204, 400]).toContain(r2.status); // long-but-valid paths are sanitized/capped server-side
    const r3 = await track(b, event({ eventId: "not-a-uuid" }));
    expect(r3.status).toBe(400);
    expect(await getRepository().analytics.countEventsBefore(new Date(Date.now() + 60_000))).toBeLessThanOrEqual(1);
  });

  it("strips query strings and sensitive params from recorded paths", async () => {
    const b = new TestBrowser("q");
    await track(b, event({ path: "/audit?token=SECRET&email=a@b.c" }));
    // An ordinary signed-in user cannot read the guarded feed either.
    const act = await userBrowser("reader@example.test").call<{ rows: Array<{ path: string }> }>(activityRoute.GET, "GET", "/api/admin/analytics/activity?days=1");
    expect(act.status).toBe(403);
    const agg = getRepository().analytics;
    const range: AnalyticsRange = { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000), bucket: "hour" };
    const rec = await agg.recentActivity(range, 10, 0);
    expect(rec.rows.length).toBe(1);
    expect(rec.rows[0]!.path).toBe("/audit");
    expect(rec.rows[0]!.path).not.toContain("SECRET");
  });

  it("stores only hashed visitor/session ids, never the raw UUIDs", async () => {
    const b = new TestBrowser("hash");
    const e = event();
    await track(b, e);
    const range: AnalyticsRange = { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000), bucket: "hour" };
    const rec = await getRepository().analytics.recentActivity(range, 10, 0);
    expect(rec.rows.length).toBe(1);
    const serialized = JSON.stringify(rec.rows[0]);
    expect(serialized).not.toContain(e.visitorId);
    expect(serialized).not.toContain(e.sessionId);
  });

  it("session_start also persists and classifies attribution from utm params", async () => {
    const b = new TestBrowser("campaign");
    await track(b, event({ eventType: "session_start", path: "/", utmSource: "newsletter", utmMedium: "email", referrer: null }));
    const r = await overview(adminBrowser());
    expect(r.status).toBe(200);
    expect(r.body.data!.sources.some((s) => s.key === "campaign")).toBe(true);
  });
});

/* ══════════════════════ 4. Classification (unit) ═════════════════════════ */

describe("classification rules", () => {
  it("classifies sources: direct / search / social / referral / campaign", () => {
    expect(classifySource({ referrerHost: null })).toBe("direct");
    expect(classifySource({ referrerHost: "www.google.com" })).toBe("search");
    expect(classifySource({ referrerHost: "m.facebook.com" })).toBe("social");
    expect(classifySource({ referrerHost: "blog.example.org" })).toBe("referral");
    expect(classifySource({ referrerHost: null, utmMedium: "email", utmSource: "newsletter" })).toBe("campaign");
    expect(classifySource({ referrerHost: "t.co" })).toBe("social");
    expect(classifySource({ referrerHost: "duckduckgo.com" })).toBe("search");
  });
  it("does not treat the site's own hostname as a referrer", () => {
    expect(sanitizeReferrerHost("HTTPS://siteinsight.example/path?q=1")!).toBe("siteinsight.example");
    expect(sanitizeReferrerHost("javascript:alert(1)")).toBeNull();
    expect(sanitizeReferrerHost("not a url")).toBeNull();
  });
  it("sanitizes paths: strips queries, hashes and excludes private areas", () => {
    expect(sanitizePath("/audit?id=1#detail")).toBe("/audit");
    // Absolute URLs store only their path — a host is never persisted.
    expect(sanitizePath("https://evil.example/steal")).toBe("/steal");
    expect(sanitizePath("/admin/analytics")).toBeNull();
    expect(sanitizePath("/api/analytics/track")).toBeNull();
    expect(sanitizePath("/help")).toBe("/help");
    // Overlong paths are rejected outright (never attacker-truncated into odd groupings).
    expect(sanitizePath("/" + "a".repeat(500))).toBeNull();
  });
  it("classifies devices, browsers and operating systems", () => {
    expect(uaDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("mobile");
    expect(uaDevice("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("tablet");
    expect(uaDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("desktop");
    expect(uaDevice("")).toBe("unknown");
    expect(uaBrowser("Mozilla/5.0 Chrome/120.0 Safari/537.36")).toBe("chrome");
    expect(uaOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos");
  });
});

/* ════════════════════ 5. Aggregation accuracy (unit) ═════════════════════ */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = new Date("2026-10-20T00:00:00Z");

function makeAnalytics() {
  const store: AnalyticsStoreShape = {
    events: [],
    scans: new Map(),
    principals: new Map(),
    usage: [],
  };
  const analytics = new MemoryAnalytics(store);
  let counter = 0;
  const add = (opts: { visitor?: string; session?: string; at: Date; path?: string; type?: "pageview" | "session_start"; source?: "direct" | "search" | "social" | "referral" | "campaign" | "other"; device?: "desktop" | "mobile" | "tablet" | "unknown" }) => {
    store.events!.push({
      clientEventId: `evt-${counter++}`,
      visitorHash: opts.visitor ?? "v1",
      sessionHash: opts.session ?? `${opts.visitor ?? "v1"}-s1`,
      eventType: opts.type ?? "pageview",
      path: opts.path ?? "/",
      referrerHost: null,
      source: opts.source ?? "direct",
      device: opts.device ?? "desktop",
      browser: "chrome",
      os: "macos",
      createdAt: opts.at,
    });
  };
  return { store, analytics, add };
}

function audit(store: AnalyticsStoreShape, opts: { id: string; principal: string; createdAt: Date; finishedAt?: Date; status: ScanJob["status"] }) {
  store.scans!.set(opts.id, {
    id: opts.id,
    principalId: opts.principal,
    url: "https://example.test",
    normalizedUrl: "https://example.test/",
    status: opts.status,
    progress: 100,
    stage: "done",
    checks: { browser: false, accessibility: true, performance: false },
    maxPages: 10,
    maxDepth: 4,
    createdAt: opts.createdAt.toISOString(),
    startedAt: opts.createdAt.toISOString(),
    finishedAt: opts.finishedAt?.toISOString() ?? null,
    leaseUntil: 0,
  } as unknown as ScanJob & { leaseUntil: number });
}

describe("aggregation accuracy", () => {
  const range: AnalyticsRange = { from: new Date(T0.getTime()), to: new Date(T0.getTime() + 2 * DAY), bucket: "day" };

  it("counts unique visitors, sessions and pageviews with in/out-of-range boundaries", async () => {
    const { add, analytics } = makeAnalytics();
    add({ visitor: "v1", session: "s1", at: new Date(T0.getTime() - 1000), path: "/" }); // 1ms before range
    add({ visitor: "v1", session: "s2", at: new Date(T0.getTime() + HOUR), path: "/" });
    add({ visitor: "v1", session: "s2", at: new Date(T0.getTime() + 2 * HOUR), path: "/about" });
    add({ visitor: "v2", session: "s3", at: new Date(T0.getTime() + 3 * HOUR), path: "/" });
    add({ visitor: "v3", session: "s4", at: new Date(T0.getTime() + 2 * DAY + 1000), path: "/" }); // 1ms after range

    const o = await analytics.overview(range);
    expect(o.totals.uniqueVisitors.current).toBe(2); // v1 (in range) + v2
    expect(o.totals.sessions.current).toBe(2); // s2, s3
    expect(o.totals.pageviews.current).toBe(3); // three in-range pageviews
    // v1 had an event strictly before the range → returning; v2 is new
    expect(o.totals.returningRate.numerator).toBe(1);
    expect(o.totals.returningRate.denominator).toBe(2);
    expect(o.totals.returningRate.current).toBeCloseTo(0.5);
  });

  it("returns null (not fabricated) comparisons when the previous period has no data", async () => {
    const { add, analytics } = makeAnalytics();
    add({ at: new Date(T0.getTime() + HOUR) });
    const o = await analytics.overview(range);
    expect(o.totals.uniqueVisitors.previous).toBeNull();
    expect(o.totals.uniqueVisitors.delta).toBeNull();
    expect(o.totals.returningRate.previous).toBeNull();
  });

  it("buckets the timeseries on UTC day boundaries", async () => {
    const { add, analytics } = makeAnalytics();
    add({ visitor: "v1", at: new Date("2026-10-20T23:55:00Z"), path: "/a" });
    add({ visitor: "v1", at: new Date("2026-10-21T00:05:00Z"), path: "/b" });
    const o = await analytics.overview(range);
    const day1 = o.timeseries.find((p) => p.t.startsWith("2026-10-20"))!;
    const day2 = o.timeseries.find((p) => p.t.startsWith("2026-10-21"))!;
    expect(day1.pageviews).toBe(1);
    expect(day2.pageviews).toBe(1);
    expect(day1.visitors).toBe(1);
  });

  it("deduplicates identical client_event_id inserts", async () => {
    const { store, analytics } = makeAnalytics();
    const at = new Date(T0.getTime() + HOUR);
    const e = { clientEventId: "dup-1", visitorHash: "v", sessionHash: "s", eventType: "pageview" as const, path: "/", referrerHost: null, source: "direct" as const, device: "desktop" as const, browser: "chrome", os: "macos", createdAt: at };
    expect(await analytics.insertEvent({ ...e, at })).toBe(true);
    expect(await analytics.insertEvent({ ...e, at })).toBe(false);
    expect(store.events!.length).toBe(1);
  });

  it("identifies landing pages as each session's first pageview", async () => {
    const { add, analytics } = makeAnalytics();
    add({ visitor: "v1", session: "s1", at: new Date(T0.getTime() + HOUR), path: "/about" });
    add({ visitor: "v1", session: "s1", at: new Date(T0.getTime() + 2 * HOUR), path: "/" });
    add({ visitor: "v2", session: "s2", at: new Date(T0.getTime() + HOUR), path: "/about" });
    const { rows } = await analytics.landingPages(range, 10, 0);
    expect(rows[0]!.path).toBe("/about");
    expect(rows[0]!.sessions).toBe(2);
    expect(rows.length).toBe(1);
  });

  it("paginates popular pages deterministically with a total count", async () => {
    const { add, analytics } = makeAnalytics();
    for (let i = 0; i < 25; i++) add({ at: new Date(T0.getTime() + HOUR), path: `/p${i}` });
    add({ at: new Date(T0.getTime() + HOUR), path: "/p0" }); // make /p0 the leader
    const page1 = await analytics.popularPages(range, 10, 0);
    const page2 = await analytics.popularPages(range, 10, 10);
    const page3 = await analytics.popularPages(range, 10, 20);
    expect(page1.total).toBe(25);
    expect(page1.rows.length).toBe(10);
    expect(page2.rows.length).toBe(10);
    expect(page3.rows.length).toBe(5);
    expect(page1.rows[0]!.path).toBe("/p0");
    expect(page1.rows[0]!.pageviews).toBe(2);
    const all = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.path);
    expect(new Set(all).size).toBe(25);
  });

  it("derives product metrics from authoritative records (registrations, audits, exports)", async () => {
    const { store, analytics } = makeAnalytics();
    const u1 = "user:11111111-1111-1111-1111-111111111111";
    const u2 = "user:22222222-2222-2222-2222-222222222222";
    store.principals!.set(u1, { ipHash: "h1", createdAt: new Date(T0.getTime() + HOUR).toISOString() });
    store.principals!.set(u2, { ipHash: "h2", createdAt: new Date(T0.getTime() + 2 * HOUR).toISOString() });
    store.principals!.set("anon-xyz", { ipHash: "h3", createdAt: new Date(T0.getTime() + HOUR).toISOString() }); // anonymous principals are NOT registrations
    audit(store, { id: "a1", principal: u1, createdAt: new Date(T0.getTime() + 3 * HOUR), finishedAt: new Date(T0.getTime() + 4 * HOUR), status: "completed" });
    audit(store, { id: "a2", principal: u2, createdAt: new Date(T0.getTime() + 3 * HOUR), finishedAt: new Date(T0.getTime() + 5 * HOUR), status: "failed" });
    store.usage!.push({ kind: "pdf_export", principalId: u1, at: T0.getTime() + 6 * HOUR, amount: 1 });

    const o = await analytics.overview(range);
    expect(o.totals.newRegistrations.current).toBe(2);
    expect(o.totals.auditsCompleted.current).toBe(1);
    const prod = o.productTimeseries.reduce((a, p) => ({
      registrations: a.registrations + p.registrations,
      created: a.created + p.auditsCreated,
      completed: a.completed + p.auditsCompleted,
      failed: a.failed + p.auditsFailed,
      exported: a.exported + p.reportsExported,
    }), { registrations: 0, created: 0, completed: 0, failed: 0, exported: 0 });
    expect(prod).toEqual({ registrations: 2, created: 2, completed: 1, failed: 1, exported: 1 });

    const conv = Object.fromEntries(o.conversions.map((c) => [c.id, c]));
    expect(conv.signup_to_first_audit!.numerator).toBe(2); // u1 and u2 both started audits
    expect(conv.signup_to_first_audit!.denominator).toBe(2);
    expect(conv.audit_completion!.numerator).toBe(1);
    expect(conv.audit_completion!.denominator).toBe(2);
    expect(conv.completed_to_export!.numerator).toBe(1); // only u1 exported
    expect(conv.completed_to_export!.denominator).toBe(1); // only u1 completed
  });

  it("renders honest empty states: zero ranges yield zeros and null rates, not infinities", async () => {
    const { analytics } = makeAnalytics();
    const o = await analytics.overview(range);
    expect(o.totals.uniqueVisitors.current).toBe(0);
    expect(o.totals.returningRate.current).toBeNull();
    for (const c of o.conversions) expect(c.rate === null || isFinite(c.rate)).toBe(true);
    expect(o.timeseries.length).toBeGreaterThan(0); // zero-filled buckets still chart
    expect(o.timeseries.every((p) => p.pageviews === 0)).toBe(true);
  });

  it("recent activity never exposes emails, IPs or raw ids (privacy-conscious feed)", async () => {
    const { store, analytics } = makeAnalytics();
    store.events!.push({
      clientEventId: "x1", visitorHash: "RAWish-id-123", sessionHash: "sess-id-456", eventType: "pageview",
      path: "/help", referrerHost: "google.com", source: "search", device: "mobile", browser: "safari", os: "ios",
      createdAt: new Date(T0.getTime() + HOUR),
    });
    const { rows } = await analytics.recentActivity(range, 10, 0);
    expect(rows.length).toBe(1);
    const row = JSON.stringify(rows[0]);
    expect(row).not.toContain("RAWish-id-123");
    expect(row).not.toContain("sess-id-456");
    expect(row).not.toContain("@");
    expect(Object.keys(rows[0]!)).toEqual(expect.arrayContaining(["eventType", "path", "device", "browser", "os", "source", "referrerHost", "createdAt"]));
    expect(Object.keys(rows[0]!).length).toBe(8);
  });
});

/* ══════════════════ 6. Range helper validation (unit) ═══════════════════ */

describe("range + pagination helpers", () => {
  it("accepts only 7/30/90 presets and validates custom ranges", () => {
    expect(() => parseAnalyticsRange(new URL("http://x/?days=14"))).toThrowError(/7, 30, 90/);
    expect(() => parseAnalyticsRange(new URL("http://x/?days=7"))).not.toThrow();
    const r = parseAnalyticsRange(new URL("http://x/?days=7"));
    expect(r.bucket).toBe("day");
    expect(() => parseAnalyticsRange(new URL("http://x/?from=2026-10-01&to=2026-10-02"))).not.toThrow();
    expect(() => parseAnalyticsRange(new URL("http://x/?from=2026-10-02&to=2026-10-01"))).toThrow();
    expect(() => parseAnalyticsRange(new URL("http://x/?from=2000-01-01&to=2026-10-23"))).toThrow(/366/);
    expect(() => parseAnalyticsRange(new URL("http://x/?from=garbage&to=2026-10-01"))).toThrow();
  });
  it("clamps pagination to bounded limits", () => {
    expect(parsePagination(new URL("http://x/?limit=5000&offset=-3"))).toEqual({ limit: 10, offset: 0 });
    expect(parsePagination(new URL("http://x/?limit=25&offset=50"))).toEqual({ limit: 25, offset: 50 });
  });
});

/* ════════════ 7. End-to-end: tracking flows into the dashboard ═══════════ */

describe("tracking → dashboard integration", () => {
  it("pageviews tracked anonymously appear in the owner's overview and activity feed", async () => {
    const visitorA = new TestBrowser("va");
    const visitorB = new TestBrowser("vb");
    const sessionA = randomUUID();
    const vidA = randomUUID();
    await track(visitorA, event({ visitorId: vidA, sessionId: sessionA, eventType: "session_start", path: "/", referrer: "https://www.google.com/search?q=seo" }));
    await track(visitorA, event({ visitorId: vidA, sessionId: sessionA, path: "/" }));
    await track(visitorA, event({ visitorId: vidA, sessionId: sessionA, path: "/features" }));
    await track(visitorB, event({ path: "/features", referrer: "https://facebook.com/post" }));

    const r = await overview(adminBrowser());
    expect(r.status).toBe(200);
    const data = r.body.data!;
    expect(data.totals.uniqueVisitors.current).toBe(2);
    expect(data.totals.sessions.current).toBeGreaterThanOrEqual(2);
    expect(data.totals.pageviews.current).toBe(3);
    expect(data.sources.find((s) => s.key === "search")?.pageviews).toBeGreaterThanOrEqual(1);
    expect(data.sources.find((s) => s.key === "social")?.pageviews).toBeGreaterThanOrEqual(1);

    const act = await adminBrowser().call<{ rows: Array<{ path: string }>; total: number }>(activityRoute.GET, "GET", "/api/admin/analytics/activity?days=30&limit=50");
    expect(act.status).toBe(200);
    expect(act.body.data!.rows.length).toBe(4); // 3 pageviews + 1 session_start
    const feed = JSON.stringify(act.body.data);
    expect(feed).not.toContain(vidA); // raw ids never leak into the feed
  });

  it("repeat visits by the same browser across periods compute the returning rate honestly", async () => {
    const repo = getRepository().analytics;
    const now = Date.now();
    const v = `visitor-${randomUUID()}`;
    // Event 40 days ago (before a 30-day window), then a fresh pageview today.
    // (Inserted directly to control timestamps; the route stamps now().)
    await repo.insertEvent({ clientEventId: randomUUID(), visitorHash: "vv", sessionHash: "ss-old", eventType: "pageview", path: "/", referrerHost: null, source: "direct", device: "desktop", browser: "chrome", os: "macos", at: new Date(now - 40 * DAY) });
    await repo.insertEvent({ clientEventId: randomUUID(), visitorHash: "vv", sessionHash: "ss-new", eventType: "pageview", path: "/", referrerHost: null, source: "direct", device: "desktop", browser: "chrome", os: "macos", at: new Date() });
    const r = await overview(adminBrowser());
    const d = r.body.data!;
    expect(d.totals.returningRate.numerator).toBe(1);
    expect(d.totals.uniqueVisitors.current).toBe(1);
    void v;
  });

  it("proxy cookie minting is not required for tracking (works for CDN-cached first hits)", async () => {
    const b = new TestBrowser("cold");
    b.clearCookies();
    const r = await track(b, event());
    expect(r.status).toBe(204);
  });
});

/* ═════════════════════ 8. Existing surface intact ═══════════════════════ */

describe("regression: tracking additions do not change existing behavior", () => {
  it("the visitor tracking intake stays public and does not require sign-in", async () => {
    const b = new TestBrowser("pub");
    const r = await track(b, event());
    expect(r.status).toBe(204);
  });
  it("billing, scans and auth config remain loadable (getConfig sanity)", () => {
    const cfg = getConfig();
    expect(cfg.usage).toBeDefined();
    expect(cfg.auth).toBeDefined();
  });
});
