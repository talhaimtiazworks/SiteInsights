import { describe, expect, it } from "vitest";
import { affordablePages, buildPlanCatalog, estimateAuditCredits } from "@/lib/billing/plans";
import { grantsPaidAccess, reduceSubscription } from "@/lib/billing/reducer";
import type { NormalizedBillingEvent, StoredSubscription } from "@/lib/billing/types";
import { MemoryCommerce } from "@/lib/db/commerce-memory";
import { csvCell, opportunityScore, prospectsToCsv } from "@/lib/leads/opportunity";
import { cleanText, prospectPatchSchema } from "@/lib/services/prospects";

const day = 86_400_000;
const T0 = new Date("2026-10-01T00:00:00Z");
const ev = (over: Partial<NormalizedBillingEvent> = {}): NormalizedBillingEvent => ({
  provider: "p",
  eventId: Math.random().toString(36),
  type: "subscription.activated",
  occurredAt: T0,
  userId: "u1",
  subscriptionRef: "s1",
  planId: "pro",
  periodStart: T0,
  periodEnd: new Date(T0.getTime() + 30 * day),
  ...over,
});
const apply = (cur: StoredSubscription | null, e: NormalizedBillingEvent) => reduceSubscription(cur, e);

describe("plan catalog", () => {
  it("has the documented defaults (free product: the active plan grants every feature)", () => {
    const c = buildPlanCatalog({});
    // The catalog retains historical Pro/Business definitions for data migration
    // and audit of old records, but the plan every actual request resolves to is Free.
    expect([c.plans.free.maxPagesPerAudit, c.plans.pro.maxPagesPerAudit, c.plans.business.maxPagesPerAudit]).toEqual([500, 150, 500]);
    // Legacy credit fields are inert metadata now that nothing is charged.
    expect([c.plans.free.monthlyCredits, c.plans.pro.monthlyCredits, c.plans.business.monthlyCredits]).toEqual([100_000, 1000, 3000]);
    expect([c.plans.free.priceUsd, c.plans.pro.priceUsd, c.plans.business.priceUsd]).toEqual([0, 5, 10]);
    expect(c.costs).toEqual({ auditStart: 10, perPage: 1, aiRequest: 2, pdfExport: 0 });
    // The free product gives Free users the originally paid feature set.
    expect(c.plans.free.features.aiExplanations).toBe(true);
    expect(c.plans.free.features.pdfExport).toBe(true);
    expect(c.plans.free.features.prospects).toBe(true);
    expect(c.plans.free.features.batchAudits).toBe(true);
    expect(c.plans.free.features.shareLinks).toBe(true);
    expect(c.plans.pro.features.prospects).toBe(false);
    expect(c.plans.business.features.prospects && c.plans.business.features.batchAudits).toBe(true);
  });
  it("applies valid overrides, rejects invalid ones and enforces the hard cap", () => {
    const w: string[] = [];
    const c = buildPlanCatalog({ PLAN_PRO_MAX_PAGES: "200", PLAN_BUSINESS_MAX_PAGES: "900", SCAN_HARD_MAX_PAGES: "600", PLAN_FREE_CREDITS: "-4", CREDIT_COST_PAGE: "2" }, w);
    expect(c.plans.pro.maxPagesPerAudit).toBe(200);
    expect(c.plans.business.maxPagesPerAudit).toBe(600);
    // Phase-out invariant: the Free plan's (inert, never-charged) allowance cannot be lowered by env.
    expect(c.plans.free.monthlyCredits).toBe(100_000);
    expect(c.costs.perPage).toBe(2);
    expect(w.some((m) => m.includes("PLAN_FREE_CREDITS"))).toBe(true);
  });
  it("estimates the maximum cost and the affordable subset", () => {
    const { costs } = buildPlanCatalog({});
    expect(estimateAuditCredits(costs, 25)).toBe(35);
    expect(estimateAuditCredits(costs, 500)).toBe(510);
    expect(affordablePages(costs, 30, 150)).toBe(20);
    expect(affordablePages(costs, 10, 150)).toBe(0);
    expect(affordablePages(costs, 3000, 150)).toBe(150);
  });
});

describe("subscription reducer", () => {
  it("activation grants paid access only for a paid plan with a future period", () => {
    const r = apply(null, ev());
    expect(r.outcome).toBe("applied");
    expect(grantsPaidAccess(r.next!, new Date(T0.getTime() + day))).toBe(true);
    expect(grantsPaidAccess(r.next!, new Date(T0.getTime() + 31 * day))).toBe(false);
    expect(apply(null, ev({ planId: "free" as never })).outcome).toBe("rejected_invalid");
    expect(apply(null, ev({ planId: "enterprise" as never })).outcome).toBe("rejected_invalid");
    expect(apply(null, ev({ periodEnd: T0 })).outcome).toBe("rejected_invalid");
  });
  it("ignores stale events and cross-account events", () => {
    const s = apply(null, ev()).next!;
    expect(apply(s, ev({ type: "subscription.expired", occurredAt: new Date(T0.getTime() - 1) })).outcome).toBe("ignored_stale");
    expect(apply(s, ev({ userId: "u2", occurredAt: new Date(T0.getTime() + 1) })).outcome).toBe("rejected_invalid");
  });
  it("failed payment keeps the paid period; recovery restores active", () => {
    const s = apply(null, ev()).next!;
    const pd = apply(s, ev({ type: "payment.failed", occurredAt: new Date(T0.getTime() + day) })).next!;
    expect(pd.status).toBe("past_due");
    expect(grantsPaidAccess(pd, new Date(T0.getTime() + 2 * day))).toBe(true);
    expect(apply(pd, ev({ type: "payment.recovered", occurredAt: new Date(T0.getTime() + 2 * day) })).next!.status).toBe("active");
  });
  it("cancel at period end keeps access; immediate cancel and expiry end it", () => {
    const s = apply(null, ev()).next!;
    const at = new Date(T0.getTime() + day);
    const c = apply(s, ev({ type: "subscription.canceled", occurredAt: at })).next!;
    expect(c.cancelAtPeriodEnd).toBe(true);
    expect(grantsPaidAccess(c, new Date(T0.getTime() + 2 * day))).toBe(true);
    const now = apply(s, ev({ type: "subscription.canceled", cancelAtPeriodEnd: false, occurredAt: at })).next!;
    expect(now.status).toBe("canceled");
    expect(grantsPaidAccess(now, new Date(at.getTime() + 1))).toBe(false);
    const exp = apply(s, ev({ type: "subscription.expired", occurredAt: at })).next!;
    expect(grantsPaidAccess(exp, new Date(at.getTime() + 1))).toBe(false);
  });
  it("renewal and update need an existing subscription", () => {
    expect(apply(null, ev({ type: "subscription.renewed" })).outcome).toBe("ignored_unknown_subscription");
    expect(apply(null, ev({ type: "subscription.updated" })).outcome).toBe("ignored_unknown_subscription");
    const s = apply(null, ev()).next!;
    const r = apply(s, ev({ type: "subscription.renewed", occurredAt: new Date(T0.getTime() + 30 * day), periodStart: new Date(T0.getTime() + 30 * day), periodEnd: new Date(T0.getTime() + 60 * day) })).next!;
    expect(r.currentPeriodEnd!.getTime()).toBe(T0.getTime() + 60 * day);
  });
});

describe("memory credit ledger", () => {
  const period = (key: string, allowance: number) => ({ planId: "free" as const, allowance, periodKey: key, periodStart: new Date(Date.now() - day), periodEnd: new Date(Date.now() + day) });
  it("grants once, never goes negative and is idempotent per key", async () => {
    const m = new MemoryCommerce();
    await Promise.all([1, 2, 3].map(() => m.ensureCreditPeriod("p", period("free:2026-10", 100))));
    expect((await m.getCreditAccount("p"))?.balance).toBe(100);
    const rs = await Promise.all(Array.from({ length: 15 }, (_, i) => m.spendCredits({ principalId: "p", amount: 10, entryType: "reserve", operation: "a", idempotencyKey: `k${i}` })));
    expect(rs.filter((r) => r.ok).length).toBe(10);
    expect((await m.getCreditAccount("p"))?.balance).toBe(0);
    const again = await m.spendCredits({ principalId: "p", amount: 10, entryType: "reserve", operation: "a", idempotencyKey: "k0" });
    expect(again.ok).toBe(true);
    expect((await m.getCreditAccount("p"))?.balance).toBe(0);
  });
});

describe("prospect text and CSV safety", () => {
  it("strips control and bidi characters", () => {
    expect(cleanText("  hi\u0000\u202Ethere\r\n ", 100)).toBe("hithere");
    expect(cleanText("   ", 10)).toBeNull();
    expect(cleanText("abcdef", 3)).toBe("abc");
  });
  it("neutralises spreadsheet formulas and quotes properly", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell(null)).toBe("");
  });
  it("exports a header row with CRLF line endings", () => {
    const csv = prospectsToCsv([], () => null);
    expect(csv.split("\r\n")[0]).toContain("Website");
  });
  it("patch schema rejects unknown fields and bad URLs", () => {
    expect(prospectPatchSchema.safeParse({ status: "contacted" }).success).toBe(true);
    expect(prospectPatchSchema.safeParse({ status: "won" }).success).toBe(false);
    expect(prospectPatchSchema.safeParse({ planId: "business" }).success).toBe(false);
    expect(prospectPatchSchema.safeParse({ contactUrl: "javascript:alert(1)" }).success).toBe(false);
  });
  it("opportunity ranks errors above recommendations", () => {
    const err = opportunityScore({ severity: "high", type: "error", category: "links", affectedCount: 3 } as never);
    const rec = opportunityScore({ severity: "high", type: "recommendation", category: "links", affectedCount: 3 } as never);
    expect(err).toBeGreaterThan(rec);
  });
});
