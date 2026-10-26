import "server-only";
import { assertAuditAccount } from "../auth/audit-policy";
import { maybeAccountRepository } from "../db";
import type { RequestContext } from "../http/context";

/**
 * Who the dashboard belongs to. With accounts enabled the dashboard requires a
 * signed-in user (validated server-side); without accounts it shows this
 * browser's audits.
 */
/** Users whose profile row is known to exist on this server instance (bounded). */
const profileReady = new Set<string>();

/**
 * Makes sure the signed-in user's profile row exists (once per user per server
 * instance). This repairs accounts whose profile could not be written during
 * sign-in, and turns a database that belongs to a different Supabase project
 * into an explicit `supabase_project_mismatch` error instead of an empty dashboard.
 */
export async function ensureAccountReady(ctx: RequestContext): Promise<void> {
  if (!ctx.user || profileReady.has(ctx.user.id)) return;
  const accounts = maybeAccountRepository();
  if (!accounts) return;
  await accounts.ensureProfile({ id: ctx.user.id, email: ctx.user.email, displayName: ctx.user.displayName });
  if (profileReady.size > 5000) profileReady.clear();
  profileReady.add(ctx.user.id);
}

/** dashboardPrincipal + ensureAccountReady, for signed-in dashboard APIs. */
export async function dashboardAccess(ctx: RequestContext): Promise<string> {
  const principalId = dashboardPrincipal(ctx);
  await ensureAccountReady(ctx);
  return principalId;
}

export function __resetAccountReadyForTests() {
  profileReady.clear();
}

export function dashboardPrincipal(ctx: RequestContext): string {
  assertAuditAccount(ctx);
  return ctx.principalId;
}

/** Organizations whose shared audits the user may see (membership verified server-side). */
export async function memberOrgIds(ctx: RequestContext): Promise<string[]> {
  if (!ctx.user) return [];
  const accounts = maybeAccountRepository();
  return accounts ? accounts.memberOrganizationIds(ctx.user.id) : [];
}
