/**
 * Billing, credits, prospects, batches and share links on PostgreSQL.
 * Skipped unless TEST_DATABASE_URL is set (writes to that database).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedBillingEvent } from "@/lib/billing/types";
import { PostgresRepository } from "@/lib/db/postgres";
import type { CreditPeriod } from "@/lib/db/commerce-types";
import { createScanJob } from "@/lib/scanner/engine";
import { loadConfig } from "@/lib/config/env";

const URL_ = process.env.TEST_DATABASE_URL;
const d = URL_ ? describe : describe.skip;

d("billing & commerce on PostgreSQL (integration)", () => {
  let repo: PostgresRepository;
  const day = 86_400_000;

  beforeAll(async () => {
    repo = new PostgresRepository(URL_!, { ssl: "disable", autoMigrate: true });
  });
  afterAll(async () => {
    await repo?.close();
  });

  async function newUser() {
    const id = randomUUID();
    await repo.ensureProfile({ id, email: `${id.slice(0, 8)}@example.com`, displayName: null });
    await repo.ensurePrincipal(`user:${id}`, "ip");
    return id;
  }
  const ev = (userId: string, over: Partial<NormalizedBillingEvent>): NormalizedBillingEvent => ({
    provider: "testpay",
    eventId: randomUUID(),
    type: "subscription.activated",
    occurredAt: new Date(),
    userId,
    subscriptionRef: `sub_${userId.slice(0, 8)}`,
    planId: "pro",
    periodStart: new Date(Date.now() - 1000),
    periodEnd: new Date(Date.now() + 30 * day),
    ...over,
  });

  it("applies verified events idempotently and resolves the plan from the subscription", async () => {
    const u = await newUser();
    const a = ev(u, {});
    expect((await repo.applyBillingEvent(a)).outcome).toBe("applied");
    expect((await repo.applyBillingEvent(a)).outcome).toBe("duplicate"); // webhook retry
    const sub = await repo.getActiveSubscription(u);
    expect(sub).toMatchObject({ planId: "pro", status: "active", provider: "testpay", cancelAtPeriodEnd: false });
    // An out-of-order (older) event cannot overwrite newer state.
    expect((await repo.applyBillingEvent(ev(u, { type: "subscription.expired", occurredAt: new Date(Date.now() - day) }))).outcome).toBe("ignored_stale");
    expect((await repo.getActiveSubscription(u))?.planId).toBe("pro");
  });

  it("the operator CLI grants and ends a manual plan with an audit trail, and refuses without --confirm", async () => {
    const u = await newUser();
    const run = (...args: string[]) => promisify(execFile)(process.execPath, ["scripts/billing/manage-subscription.mjs", ...args], { env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", DATABASE_URL: URL_!, DATABASE_SSL: "disable", USER: "test-operator" } });
    await expect(run("grant", "--user", u, "--plan", "business", "--reason", "Pilot customer")).rejects.toThrow(/--confirm/);
    expect(await repo.getActiveSubscription(u)).toBeNull();
    const granted = await run("grant", "--user", u, "--plan", "business", "--months", "1", "--reason", "Pilot customer", "--confirm");
    expect(granted.stdout).toMatch(/Granted business until/);
    const sub = await repo.getActiveSubscription(u);
    expect(sub).toMatchObject({ planId: "business", status: "active", provider: "manual", cancelAtPeriodEnd: true });
    expect(new Date(sub!.currentPeriodEnd!).getTime()).toBeGreaterThan(Date.now() + 27 * day);
    const shown = JSON.parse((await run("show", "--user", u)).stdout);
    expect(shown.subscriptions[0]).toMatchObject({ plan_id: "business", provider: "manual" });
    expect((await run("end", "--user", u, "--reason", "Pilot finished", "--confirm")).stdout).toMatch(/Ended 1 manual subscription/);
    expect(await repo.getActiveSubscription(u)).toBeNull();
    expect((await repo.getRecentlyEndedSubscription(u, new Date(Date.now() - day)))?.planId).toBe("business"); // history grace applies
  }, 30_000);

  it("rejects events for unknown accounts but re-evaluates the same event once the account exists", async () => {
    const id = randomUUID();
    const e = ev(id, {});
    expect((await repo.applyBillingEvent(e)).outcome).toBe("rejected_unknown_user");
    await repo.ensureProfile({ id, email: null, displayName: null });
    expect((await repo.applyBillingEvent(e)).outcome).toBe("applied");
    expect((await repo.applyBillingEvent(e)).outcome).toBe("duplicate");
  });

  it("handles failed payment, cancel-at-period-end, expiry and the downgrade history grace", async () => {
    const u = await newUser();
    await repo.applyBillingEvent(ev(u, { planId: "business" }));
    expect((await repo.applyBillingEvent(ev(u, { type: "payment.failed", occurredAt: new Date(Date.now() + 1000) }))).subscription?.status).toBe("past_due");
    // past_due keeps the already-paid period.
    expect((await repo.getActiveSubscription(u))?.planId).toBe("business");
    await repo.applyBillingEvent(ev(u, { type: "subscription.canceled", cancelAtPeriodEnd: true, occurredAt: new Date(Date.now() + 2000) }));
    const s = await repo.getActiveSubscription(u);
    expect(s?.cancelAtPeriodEnd).toBe(true);
    await repo.applyBillingEvent(ev(u, { type: "subscription.expired", occurredAt: new Date(Date.now() + 3000) }));
    expect(await repo.getActiveSubscription(u)).toBeNull();
    const ended = await repo.getRecentlyEndedSubscription(u, new Date(Date.now() - 30 * day));
    expect(ended?.planId).toBe("business");
  });

  it("a renewal requires an existing subscription and a valid paid period", async () => {
    const u = await newUser();
    expect((await repo.applyBillingEvent(ev(u, { type: "subscription.renewed" }))).outcome).toBe("ignored_unknown_subscription");
    expect((await repo.applyBillingEvent(ev(u, { planId: "free" as never }))).outcome).toBe("rejected_invalid");
    expect((await repo.applyBillingEvent(ev(u, { periodEnd: new Date(Date.now() - day) }))).outcome).toBe("rejected_invalid");
    expect(await repo.getActiveSubscription(u)).toBeNull();
  });

  it("an upgrade supersedes the previous live subscription", async () => {
    const u = await newUser();
    await repo.applyBillingEvent(ev(u, { subscriptionRef: "a-" + u }));
    await repo.applyBillingEvent(ev(u, { subscriptionRef: "b-" + u, planId: "business", occurredAt: new Date(Date.now() + 1000) }));
    expect((await repo.getActiveSubscription(u))?.planId).toBe("business");
  });

  describe("credit ledger", () => {
    const period = (key: string, allowance = 100): CreditPeriod => ({ planId: "free", allowance, periodKey: key, periodStart: new Date(Date.now() - day), periodEnd: new Date(Date.now() + day) });

    it("grants once per period and expires unused credits on rollover", async () => {
      const p = `user:${await newUser()}`;
      await Promise.all([1, 2, 3, 4].map(() => repo.commerce.ensureCreditPeriod(p, period("free:2026-10"))));
      expect((await repo.commerce.getCreditAccount(p))?.balance).toBe(100);
      await repo.commerce.spendCredits({ principalId: p, amount: 30, entryType: "charge", operation: "x", idempotencyKey: "k1" });
      const next = await repo.commerce.ensureCreditPeriod(p, { ...period("sub:abc:2026-11-01", 1000), planId: "pro" });
      expect(next.balance).toBe(1000);
      const ledger = await repo.commerce.listLedger(p, 50, 0);
      expect(ledger.items.map((e) => e.entryType)).toEqual(["grant", "expire", "charge", "grant"]);
      expect(ledger.items.find((e) => e.entryType === "expire")?.delta).toBe(-70);
    });

    it("never double-spends or goes negative under concurrency, and is idempotent per key", async () => {
      const p = `user:${await newUser()}`;
      await repo.commerce.ensureCreditPeriod(p, period("free:2026-10"));
      const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => repo.commerce.spendCredits({ principalId: p, amount: 10, entryType: "reserve", operation: "audit", idempotencyKey: `r${i}` })));
      expect(rs.filter((r) => r.ok).length).toBe(10);
      expect((await repo.commerce.getCreditAccount(p))?.balance).toBe(0);
      const replay = await repo.commerce.spendCredits({ principalId: p, amount: 10, entryType: "reserve", operation: "audit", idempotencyKey: "r0" });
      expect(replay.ok && replay.replayed).toBe(true);
      // Parallel identical refunds credit once.
      await Promise.all([1, 2, 3].map(() => repo.commerce.creditCredits({ principalId: p, amount: 10, entryType: "refund", operation: "x", idempotencyKey: "refund-1", sourcePeriodKey: "free:2026-10" })));
      expect((await repo.commerce.getCreditAccount(p))?.balance).toBe(10);
      // A refund from an expired period is recorded but not added to the new period.
      const stale = await repo.commerce.creditCredits({ principalId: p, amount: 10, entryType: "release", operation: "x", idempotencyKey: "old", sourcePeriodKey: "free:2026-09" });
      expect(stale.entry?.delta).toBe(0);
      expect((await repo.commerce.getCreditAccount(p))?.balance).toBe(10);
    });

    it("lists unsettled audit reservations for the sweep", async () => {
      const p = `user:${await newUser()}`;
      await repo.commerce.ensureCreditPeriod(p, period("free:2026-10"));
      const auditId = randomUUID();
      await repo.commerce.spendCredits({ principalId: p, amount: 35, entryType: "reserve", operation: "audit", auditId, idempotencyKey: `audit:${auditId}:reserve` });
      expect((await repo.commerce.listUnsettledReservations(500)).some((r) => r.auditId === auditId)).toBe(true);
      await repo.commerce.creditCredits({ principalId: p, amount: 35, entryType: "release", operation: "audit_settlement", auditId, idempotencyKey: `audit:${auditId}:settle`, sourcePeriodKey: "free:2026-10" });
      expect((await repo.commerce.listUnsettledReservations(500)).some((r) => r.auditId === auditId)).toBe(false);
    });
  });

  it("prospects are unique per site and owner-scoped; search escapes wildcards", async () => {
    const a = `user:${await newUser()}`;
    const b = `user:${await newUser()}`;
    const one = await repo.commerce.upsertProspect(a, { hostname: "acme.example", websiteUrl: "https://acme.example/", auditId: null, evidence: null, auditedAt: null });
    const again = await repo.commerce.upsertProspect(a, { hostname: "acme.example", websiteUrl: "https://acme.example/", auditId: null, evidence: null, auditedAt: new Date().toISOString() });
    expect(one.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.prospect.id).toBe(one.prospect.id);
    await repo.commerce.upsertProspect(a, { hostname: "100percent.example", websiteUrl: "https://100percent.example/", auditId: null, evidence: null, auditedAt: null });
    expect(await repo.commerce.getProspect(b, one.prospect.id)).toBeNull();
    expect(await repo.commerce.updateProspect(b, one.prospect.id, { status: "converted" })).toBeNull();
    expect(await repo.commerce.deleteProspect(b, one.prospect.id)).toBe(false);
    expect((await repo.commerce.listProspects({ principalId: a, search: "%", limit: 10, offset: 0 })).total).toBe(0);
    expect((await repo.commerce.listProspects({ principalId: a, search: "acme", limit: 10, offset: 0 })).total).toBe(1);
    const up = await repo.commerce.updateProspect(a, one.prospect.id, { status: "reviewing", notes: "Called" });
    expect(up?.status).toBe("reviewing");
    expect((await repo.commerce.listProspects({ principalId: a, status: "reviewing", limit: 10, offset: 0 })).byStatus.reviewing).toBe(1);
  });

  it("batch items are claimed exactly once under concurrency", async () => {
    const p = `user:${await newUser()}`;
    const now = new Date().toISOString();
    const batchId = randomUUID();
    await repo.commerce.createBatch({
      id: batchId,
      principalId: p,
      ipHash: "ip",
      createdAt: now,
      items: [0, 1, 2].map((i) => ({ id: randomUUID(), batchId, principalId: p, position: i, url: `https://s${i}.example/`, maxPages: 10, status: "pending" as const, auditId: null, error: null, createdAt: now, updatedAt: now })),
    });
    const claims = await Promise.all(Array.from({ length: 6 }, () => repo.commerce.claimNextBatchItem(p)));
    const got = claims.filter(Boolean).map((c) => c!.id);
    expect(got).toHaveLength(3);
    expect(new Set(got).size).toBe(3);
  });

  it("share links work until revoked or expired and are deleted with the audit", async () => {
    const p = `user:${await newUser()}`;
    const s = loadConfig({}).scanner;
    const job = createScanJob({ principalId: p, websiteId: null, targetUrl: "https://acme.example/", limits: { ...s, maxPages: 5 } });
    await repo.createScan(job);
    const mk = (hash: string, expiresAt: string) => ({ id: randomUUID(), principalId: p, auditId: job.id, tokenHash: hash, label: null, allowPdf: true, createdAt: new Date().toISOString(), expiresAt, revokedAt: null, lastViewedAt: null, viewCount: 0 });
    const live = mk("a".repeat(64), new Date(Date.now() + day).toISOString());
    await repo.commerce.createReportShare(live);
    await repo.commerce.createReportShare(mk("b".repeat(64), new Date(Date.now() - 1000).toISOString()));
    expect((await repo.commerce.useReportShare("a".repeat(64)))?.viewCount).toBe(1);
    expect(await repo.commerce.useReportShare("b".repeat(64))).toBeNull();
    expect(await repo.commerce.revokeReportShare(`user:${randomUUID()}`, live.id)).toBe(false);
    expect(await repo.commerce.revokeReportShare(p, live.id)).toBe(true);
    expect(await repo.commerce.useReportShare("a".repeat(64))).toBeNull();
    await repo.deleteScan(job.id);
    expect(await repo.commerce.listReportShares(p, job.id)).toEqual([]);
  });
});
