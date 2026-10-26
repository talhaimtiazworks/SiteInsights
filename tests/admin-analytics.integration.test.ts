/**
 * Production-parity analytics tests against REAL PostgreSQL. Skipped unless
 * TEST_DATABASE_URL points at a database the migrator can write to (the same
 * convention as scan-lifecycle/postgres/rls integration suites).
 *
 * These cover the code paths the in-memory implementation cannot: actual SQL
 * for overview/popular/landings/activity, product-metric derivations against
 * the post-004-renamed tables (audits, usage_records, profiles), and the
 * unique client_event_id dedupe constraint enforced by the database itself.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __resetConfigForTests } from "@/lib/config/env";
import { __resetRepositoryForTests, getRepository } from "@/lib/db";
import type { PostgresRepository } from "@/lib/db/postgres";
import type { AnalyticsOverview } from "@/lib/db/analytics-types";

const PG_URL = process.env.TEST_DATABASE_URL;
const describePg = PG_URL ? describe : describe.skip;

describePg("admin analytics on real PostgreSQL", () => {
  let repo: PostgresRepository;
  const range = () => ({ from: new Date(Date.now() - 30 * 86_400_000), to: new Date(), bucket: "day" as const });

  beforeAll(async () => {
    process.env.DATABASE_URL = PG_URL;
    __resetConfigForTests();
    __resetRepositoryForTests();
    repo = getRepository() as PostgresRepository;

    const vh = "v".repeat(32);
    const sh = "s".repeat(32);
    await repo.analytics.insertEvent({ clientEventId: randomUUID(), visitorHash: vh, sessionHash: sh, eventType: "session_start", path: "/", referrerHost: "google.com", source: "search", device: "desktop", browser: "chrome", os: "windows" });
    await repo.analytics.insertEvent({ clientEventId: randomUUID(), visitorHash: vh, sessionHash: sh, eventType: "pageview", path: "/", referrerHost: null, source: "search", device: "desktop", browser: "chrome", os: "windows" });
    await repo.analytics.insertEvent({ clientEventId: randomUUID(), visitorHash: "w".repeat(32), sessionHash: "t".repeat(32), eventType: "pageview", path: "/features", referrerHost: null, source: "direct", device: "mobile", browser: "safari", os: "ios" });
  });

  afterAll(async () => {
    await repo.close?.();
    delete process.env.DATABASE_URL;
    __resetConfigForTests();
    __resetRepositoryForTests();
  });

  it("overview aggregates without SQL errors and with honest previous-period nulls", async () => {
    const ov: AnalyticsOverview = await repo.analytics.overview(range());
    expect(ov.totals.uniqueVisitors.current).toBeGreaterThanOrEqual(2);
    expect(ov.totals.pageviews.current).toBeGreaterThanOrEqual(2);
    expect(ov.timeseries.length).toBeGreaterThanOrEqual(30);
    expect(ov.timeseries.every((p) => typeof p.t === "string" && isFinite(p.pageviews))).toBe(true);
    expect(ov.sources.some((s) => s.key === "search")).toBe(true);
    expect(ov.devices.some((d) => d.key === "mobile")).toBe(true);
  });

  it("product metrics come from audits/profiles/usage_records (post-rename tables)", async () => {
    const ov = await repo.analytics.overview(range());
    // Numbers depend on fixture rows created by the test database setup; all
    // three conversion rates must be finite-or-null (never NaN/Infinity).
    expect(Number.isInteger(ov.totals.newRegistrations.current)).toBe(true);
    expect(Number.isInteger(ov.totals.auditsCompleted.current)).toBe(true);
    for (const c of ov.conversions) {
      expect(c.rate === null || (isFinite(c.rate) && c.rate >= 0 && c.rate <= 1)).toBe(true);
      expect(c.numerator).toBeLessThanOrEqual(Math.max(c.denominator, 0));
    }
    const product = ov.productTimeseries.reduce((a, p) => a + p.registrations + p.auditsCreated + p.auditsCompleted + p.auditsFailed + p.reportsExported, 0);
    expect(product).toBeGreaterThanOrEqual(0);
  });

  it("unique client_event_id dedupe is enforced by the database constraint", async () => {
    const id = randomUUID();
    const base = { visitorHash: "z".repeat(32), sessionHash: "y".repeat(32), eventType: "pageview" as const, path: `/dedupe-${id.slice(0, 8)}`, referrerHost: null, source: "direct" as const, device: "desktop" as const, browser: "chrome", os: "linux" };
    expect(await repo.analytics.insertEvent({ ...base, clientEventId: id })).toBe(true);
    expect(await repo.analytics.insertEvent({ ...base, clientEventId: id })).toBe(false); // retry: no-op
    const r = range();
    const rec = await repo.analytics.recentActivity(r, 50, 0);
    expect(rec.rows.filter((row) => row.path === base.path).length).toBe(1); // one logical event, one stored row
  });

  it("popular/landing/activity stay within bounds and carry totals", async () => {
    const r = range();
    const pop = await repo.analytics.popularPages(r, 5, 0);
    expect(pop.rows.length).toBeLessThanOrEqual(5);
    expect(pop.total).toBeGreaterThanOrEqual(pop.rows.length);
    const land = await repo.analytics.landingPages(r, 5, 0);
    expect(land.rows.every((row) => row.path.startsWith("/"))).toBe(true);
    const act = await repo.analytics.recentActivity(r, 5, 0);
    expect(act.rows.length).toBeLessThanOrEqual(5);
    expect(act.total).toBeGreaterThanOrEqual(act.rows.length);
    // Privacy: the serialized rows must never contain raw ids/emails.
    expect(JSON.stringify(act.rows)).not.toMatch(/@|user:[0-9a-f-]{36}/i);
  });
});
