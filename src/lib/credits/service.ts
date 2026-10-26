import "server-only";
import { getConfig } from "../config/env";
import { getRepository } from "../db";
import type { CreditAccount, CreditPeriod, LedgerEntry } from "../db/commerce-types";
import type { Repository } from "../db/types";
import { affordablePages, estimateAuditCredits, type CreditCosts } from "../billing/plans";
import { ApiError } from "../http/api";
import { logger } from "../logger";
import type { PageRecord, ScanJob } from "../scanner/types";
import { isTerminal } from "../scans/state-machine";
import { resolvePlan, type PlanResolution } from "../services/plan";

/**
 * Credit system.
 *
 * - Each billing period grants the plan's monthly allowance; unused credits
 *   expire at the end of the period (no roll-over). Free accounts use calendar
 *   months (UTC). Paid accounts use the verified subscription period, so a new
 *   grant happens only after a renewal payment was verified.
 * - Audits RESERVE their maximum cost before any work is queued
 *   (start fee + page limit × page cost) and are SETTLED when they end:
 *   see `settleAuditCredits` for the refund policy.
 * - AI requests are charged before the provider is called and refunded if the
 *   provider fails.
 * - Every movement is an append-only ledger entry with a unique idempotency
 *   key; balance updates are atomic, so retries and concurrent requests can
 *   neither double-charge nor spend the same credits twice.
 */

export const LOW_BALANCE_RATIO = 0.15;

function monthBounds(now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end, key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}` };
}

/** The credit period that SHOULD be current for this plan resolution. */
export function creditPeriodFor(res: PlanResolution, now = new Date()): CreditPeriod {
  const sub = res.subscription;
  if (sub && sub.currentPeriodStart && sub.currentPeriodEnd && Date.parse(sub.currentPeriodEnd) > now.getTime()) {
    return {
      planId: res.ent.plan,
      allowance: res.ent.monthlyCredits,
      periodKey: `sub:${sub.id}:${new Date(sub.currentPeriodStart).toISOString()}`,
      periodStart: new Date(sub.currentPeriodStart),
      periodEnd: new Date(sub.currentPeriodEnd),
    };
  }
  const m = monthBounds(now);
  return { planId: res.ent.plan, allowance: res.ent.monthlyCredits, periodKey: `free:${m.key}`, periodStart: m.start, periodEnd: m.end };
}

export interface CreditContext extends PlanResolution {
  account: CreditAccount;
  costs: CreditCosts;
}

/** Resolves the verified plan and brings the credit account into the current period (idempotent). */
export async function ensureCreditAccount(principalId: string, repo: Repository = getRepository()): Promise<CreditContext> {
  const res = await resolvePlan(principalId);
  const account = await repo.commerce.ensureCreditPeriod(principalId, creditPeriodFor(res));
  return { ...res, account, costs: getConfig().plans.costs };
}

export interface CreditSummary {
  balance: number;
  allowance: number;
  used: number;
  periodStart: string;
  periodEnd: string;
  resetsAt: string;
  low: boolean;
  costs: CreditCosts;
  plan: { id: string; label: string; maxPagesPerAudit: number };
  /** Largest audit (pages) affordable right now. 0 = cannot start an audit. */
  affordablePages: number;
  /** Maximum cost of an audit at the plan's page limit. */
  fullAuditCost: number;
}

export function summarize(ctx: CreditContext): CreditSummary {
  const { account, ent, costs } = ctx;
  return {
    balance: account.balance,
    allowance: account.allowance,
    used: Math.max(0, account.allowance - account.balance),
    periodStart: account.periodStart,
    periodEnd: account.periodEnd,
    resetsAt: account.periodEnd,
    low: account.allowance > 0 && account.balance < Math.max(costs.auditStart + costs.perPage, Math.ceil(account.allowance * LOW_BALANCE_RATIO)),
    costs,
    plan: { id: ent.plan, label: ent.planLabel, maxPagesPerAudit: ent.maxPagesPerScan },
    affordablePages: affordablePages(costs, account.balance, ent.maxPagesPerScan),
    fullAuditCost: estimateAuditCredits(costs, ent.maxPagesPerScan),
  };
}

export const auditReserveKey = (auditId: string) => `audit:${auditId}:reserve`;
export const auditSettleKey = (auditId: string) => `audit:${auditId}:settle`;

export function insufficientCreditsError(ctx: CreditContext, required: number, requestedPages: number) {
  const pages = affordablePages(ctx.costs, ctx.account.balance, ctx.ent.maxPagesPerScan);
  return new ApiError(
    402,
    "insufficient_credits",
    pages > 0
      ? `An audit of up to ${requestedPages} pages can cost up to ${required} credits, but you have ${ctx.account.balance}. You can scan up to ${pages} pages instead (max ${estimateAuditCredits(ctx.costs, pages)} credits).`
      : `You have ${ctx.account.balance} credits; an audit needs at least ${ctx.costs.auditStart + ctx.costs.perPage}. Credits reset on ${new Date(ctx.account.periodEnd).toUTCString().slice(5, 16)}.`,
    { balance: ctx.account.balance, required, affordablePages: pages, affordableCost: pages > 0 ? estimateAuditCredits(ctx.costs, pages) : 0, resetsAt: ctx.account.periodEnd, plan: ctx.ent.plan },
  );
}

/** Reserves the maximum cost of an audit. Throws 402 when the balance (checked atomically) is insufficient. */
export async function reserveAuditCredits(repo: Repository, ctx: CreditContext, auditId: string, maxPages: number): Promise<LedgerEntry> {
  const amount = estimateAuditCredits(ctx.costs, maxPages);
  const r = await repo.commerce.spendCredits({
    principalId: ctx.account.principalId,
    amount,
    entryType: "reserve",
    operation: "audit",
    auditId,
    idempotencyKey: auditReserveKey(auditId),
    detail: { maxPages, auditStart: ctx.costs.auditStart, perPage: ctx.costs.perPage, plan: ctx.ent.plan },
  });
  if (!r.ok) throw insufficientCreditsError({ ...ctx, account: { ...ctx.account, balance: r.balance } }, amount, maxPages);
  return r.entry;
}

/** Unique pages that actually returned an HTTP response (redirects to the same final URL count once). */
export function uniqueProcessedPages(pages: PageRecord[]): number {
  return new Set(pages.filter((p) => p.statusCode !== null).map((p) => p.finalUrl)).size;
}

export type SettlementPolicy = "completed" | "cancelled" | "failed_refunded" | "deleted_refunded" | "stalled_refunded";

/**
 * Settles an audit's reservation exactly once (idempotent per audit).
 *
 * Refund policy of the retired credit layer:
 *  - completed / completed with warnings / cancelled by the user: charge the
 *    start fee + one page cost per unique page actually processed; the rest of
 *    the reservation is returned.
 *  - failed (internal error, site unreachable, robots.txt disallow …): full
 *    refund, because no usable report was produced.
 *  - deleted or stalled before finishing: full refund.
 * Credits reserved in an earlier billing period are recorded but not carried
 * into the new period.
 */
export async function settleAuditCredits(repo: Repository, ref: { principalId: string; auditId: string }, scan: ScanJob | null, opts: { stalled?: boolean } = {}): Promise<{ settled: boolean; charged: number; released: number } | null> {
  const c = repo.commerce;
  const reserve = await c.getLedgerEntry(ref.principalId, auditReserveKey(ref.auditId));
  if (!reserve) return null; // audit created before the credit system, or never reserved
  const existing = await c.getLedgerEntry(ref.principalId, auditSettleKey(ref.auditId));
  const reserved = -reserve.delta;
  if (existing) return { settled: false, charged: reserved - Number(existing.detail.released ?? existing.delta), released: Number(existing.detail.released ?? existing.delta) };
  if (scan && !isTerminal(scan.status) && !opts.stalled) return null;
  const auditStart = Number(reserve.detail.auditStart ?? 0);
  const perPage = Number(reserve.detail.perPage ?? 0);
  let charged = 0;
  let pagesProcessed = 0;
  let policy: SettlementPolicy;
  if (!scan) policy = "deleted_refunded";
  else if (opts.stalled) policy = "stalled_refunded";
  else if (scan.status === "failed") policy = "failed_refunded";
  else {
    pagesProcessed = uniqueProcessedPages(await repo.listPages(scan.id));
    charged = Math.min(reserved, auditStart + pagesProcessed * perPage);
    policy = scan.status === "cancelled" ? "cancelled" : "completed";
  }
  const released = reserved - charged;
  await c.creditCredits({
    principalId: ref.principalId,
    amount: released,
    entryType: "release",
    operation: "audit_settlement",
    auditId: ref.auditId,
    idempotencyKey: auditSettleKey(ref.auditId),
    sourcePeriodKey: reserve.periodKey,
    detail: { reserved, charged, released, pagesProcessed, policy, status: scan?.status ?? "deleted", auditStart, perPage },
  });
  return { settled: true, charged, released };
}

/** Never throws: settlement is retried by the background sweep. */
export async function settleAuditCreditsSafe(repo: Repository, ref: { principalId: string; auditId: string }, scan: ScanJob | null, opts: { stalled?: boolean } = {}) {
  try {
    return await settleAuditCredits(repo, ref, scan, opts);
  } catch (err) {
    logger.warn("Credit settlement failed; it will be retried", err);
    return null;
  }
}

/**
 * FREE PRODUCT: operations are never charged. This function now always
 * succeeds without spending, so no caller can gate a feature behind a credit
 * balance. The historical ledger is untouched (settleAuditCredits can still
 * refund pre-conversion reservations); the original implementation stays
 * below for the operator's migration/cleanup decision.
 */
export async function chargeOperation(repo: Repository, ctx: CreditContext, p: { amount: number; operation: string; key: string; auditId?: string | null; detail?: Record<string, unknown> }) {
  const noop = async () => {};
  return { refund: noop, charged: 0 };
  if (p.amount <= 0) return { refund: noop, charged: 0 };
  const r = await repo.commerce.spendCredits({ principalId: ctx.account.principalId, amount: p.amount, entryType: "charge", operation: p.operation, auditId: p.auditId ?? null, idempotencyKey: p.key, detail: p.detail });
  if (!r.ok) {
    throw new ApiError(402, "insufficient_credits", `This costs ${p.amount} credits; you have ${r.balance}. Credits reset on ${new Date(ctx.account.periodEnd).toUTCString().slice(5, 16)}.`, { balance: r.balance, required: p.amount, resetsAt: ctx.account.periodEnd });
  }
  const refund = async () => {
    try {
      await repo.commerce.creditCredits({ principalId: ctx.account.principalId, amount: p.amount, entryType: "refund", operation: `${p.operation}_refund`, auditId: p.auditId ?? null, idempotencyKey: `${p.key}:refund`, sourcePeriodKey: (r as { entry: { periodKey: string } }).entry.periodKey, detail: { reason: "The operation failed; credits returned." } });
    } catch (err) {
      logger.warn("Credit refund failed", err);
    }
  };
  return { refund, charged: p.amount };
}
