import "server-only";
import { getConfig } from "../config/env";
import { getRepository, maybeAccountRepository, storageInfo } from "../db";
import type { RequestContext } from "../http/context";
import { peekUsage } from "../usage/meter";
import { ACTIVE_WINDOW_MS, availableChecks, entitlementsFor } from "./scans";
import { billingStatus } from "../billing/registry";
import { ensureCreditAccount, summarize, type CreditSummary } from "../credits/service";

/** Current plan, limits and real usage (with reset times) for the caller. */
export async function usageSnapshot(ctx: RequestContext) {
  const repo = getRepository();
  const ent = await entitlementsFor(ctx);
  const [scans, ai, browserPages, accessibility, performance, pdf, active] = await Promise.all([
    peekUsage(repo, ctx, "scan", ent),
    peekUsage(repo, ctx, "ai_request", ent),
    peekUsage(repo, ctx, "browser_page", ent),
    peekUsage(repo, ctx, "accessibility_test", ent),
    peekUsage(repo, ctx, "performance_test", ent),
    peekUsage(repo, ctx, "pdf_export", ent),
    repo.countActiveScans({ principalId: ctx.principalId, activeSince: new Date(Date.now() - ACTIVE_WINDOW_MS) }),
  ]);
  let subscription = null;
  if (ctx.user) {
    const accounts = maybeAccountRepository();
    const sub = accounts ? await accounts.getActiveSubscription(ctx.user.id) : null;
    if (sub) subscription = { planId: sub.planId, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd, cancelAt: sub.cancelAt, cancelAtPeriodEnd: sub.cancelAtPeriodEnd };
  }
  // Credits exist for signed-in accounts only (audits require an account).
  let credits: CreditSummary | null = null;
  if (ctx.user && ctx.principalId.startsWith("user:")) {
    await repo.ensurePrincipal(ctx.principalId, ctx.ipHash);
    credits = summarize(await ensureCreditAccount(ctx.principalId, repo));
  }
  const { ipLimitMultiplier: _m, ...publicEnt } = ent;
  void _m;
  const a = availableChecks();
  return {
    entitlements: publicEnt,
    plan: { id: ent.plan, label: ent.planLabel, subscription, billingAvailable: billingStatus().state === "ready" },
    credits,
    usage: { scans, ai, browserPages, accessibility, performance, pdf },
    available: { browserRendering: a.browser, accessibility: a.accessibility, performance: a.performance },
    activeScans: active,
    storage: storageInfo(),
    account: { signedIn: !!ctx.user, accountsEnabled: getConfig().auth.supabase.authEnabled },
  };
}
