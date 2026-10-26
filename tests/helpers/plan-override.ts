/**
 * Test seam for plan resolution in MEMORY mode (no PostgreSQL, hence no
 * subscriptions table). Production resolves plans only from verified
 * subscription rows (src/lib/services/plan.ts); the Postgres integration tests
 * exercise that path end to end. Usage in a test file:
 *
 *   vi.mock("@/lib/services/plan", async (orig) => (await import("./helpers/plan-override")).planModuleMock(await orig()));
 *   planOverrides.set("user:<uuid>", "pro");
 */
import type { PlanId } from "@/lib/billing/plans";

export const planOverrides = new Map<string, PlanId>();

type PlanModule = typeof import("@/lib/services/plan");

export function planModuleMock(real: PlanModule): PlanModule {
  const resolvePlan: PlanModule["resolvePlan"] = async (principalId) => {
    const plan = planOverrides.get(principalId);
    if (!plan || plan === "free") return real.resolvePlan(principalId);
    const { getConfig } = await import("@/lib/config/env");
    const { getEntitlements } = await import("@/lib/usage/entitlements");
    const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    return {
      ent: getEntitlements({ id: principalId, plan, isUser: true }, getConfig()),
      subscription: {
        id: `00000000-0000-4000-8000-${Buffer.from(principalId).toString("hex").slice(-12).padStart(12, "0")}`,
        planId: plan,
        status: "active",
        provider: "test",
        currentPeriodStart: start.toISOString(),
        currentPeriodEnd: end.toISOString(),
        cancelAt: null,
        cancelAtPeriodEnd: false,
      } as never,
    };
  };
  return { ...real, resolvePlan, entitlementsForPrincipal: async (id) => (await resolvePlan(id)).ent };
}
