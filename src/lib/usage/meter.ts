import type { Repository, UsageKind } from "../db/types";
import type { Entitlements } from "./entitlements";

/**
 * Server-side usage metering. Limits are enforced per anonymous principal
 * (HttpOnly cookie) AND per hashed client IP. Clearing cookies therefore does
 * not reset the allowance; the IP allowance is a multiple of the per-principal
 * allowance so that shared networks (schools, offices) are not over-penalised.
 */
export interface UsageDecision {
  kind: UsageKind;
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  windowSeconds: number;
  resetAt: string | null;
  limitedBy: "principal" | "ip" | "burst" | null;
}

/** Short-window cap for kinds that have one (audit creation, AI requests). */
export function burstFor(kind: UsageKind, ent: Entitlements): { limit: number; windowSeconds: number } | null {
  if (kind === "scan") return { limit: ent.auditBurstLimit, windowSeconds: ent.auditBurstWindowSeconds };
  if (kind === "ai_request") return { limit: ent.aiBurstLimit, windowSeconds: ent.aiBurstWindowSeconds };
  return null;
}

export function limitsFor(kind: UsageKind, ent: Entitlements) {
  const table: Record<UsageKind, [number, number]> = {
    scan: [ent.scansPerWindow, ent.scanWindowSeconds],
    ai_request: [ent.aiRequestsPerWindow, ent.aiWindowSeconds],
    browser_page: [ent.browserPagesPerWindow, ent.advancedWindowSeconds],
    accessibility_test: [ent.accessibilityTestsPerWindow, ent.advancedWindowSeconds],
    performance_test: [ent.performanceTestsPerWindow, ent.advancedWindowSeconds],
    pdf_export: [ent.pdfExportsPerWindow, ent.advancedWindowSeconds],
  };
  const [limit, windowSeconds] = table[kind];
  return { limit, ipLimit: limit * ent.ipLimitMultiplier, windowSeconds };
}

function decide(kind: UsageKind, ent: Entitlements, c: { byPrincipal: number; byIp: number; oldestPrincipal: Date | null; oldestIp: Date | null }, allowed: boolean, consumed: boolean): UsageDecision {
  const { limit, ipLimit, windowSeconds } = limitsFor(kind, ent);
  const usedP = c.byPrincipal + (consumed ? 1 : 0);
  const usedI = c.byIp + (consumed ? 1 : 0);
  const ipBound = usedI >= ipLimit && ipLimit - usedI < limit - usedP;
  const limitedBy = !allowed ? (c.byIp >= ipLimit ? "ip" : "principal") : null;
  const oldest = (limitedBy ?? (ipBound ? "ip" : "principal")) === "ip" ? c.oldestIp : c.oldestPrincipal;
  const remaining = Math.max(0, Math.min(limit - usedP, ipLimit - usedI));
  return {
    kind,
    allowed,
    used: usedP,
    limit,
    remaining,
    windowSeconds,
    resetAt: oldest ? new Date(oldest.getTime() + windowSeconds * 1000).toISOString() : null,
    limitedBy,
  };
}

export async function consumeUsage(repo: Repository, ctx: { principalId: string; ipHash: string }, kind: UsageKind, ent: Entitlements): Promise<UsageDecision> {
  const { limit, ipLimit, windowSeconds } = limitsFor(kind, ent);
  const since = new Date(Date.now() - windowSeconds * 1000);
  const b = burstFor(kind, ent);
  const res = await repo.consumeUsage({ kind, principalId: ctx.principalId, ipHash: ctx.ipHash, principalLimit: limit, ipLimit, since, burst: b ? { limit: b.limit, since: new Date(Date.now() - b.windowSeconds * 1000) } : undefined });
  const d = decide(kind, ent, res, res.allowed, res.allowed);
  if (res.burstLimited && b) return { ...d, limitedBy: "burst", resetAt: new Date(Date.now() + b.windowSeconds * 1000).toISOString() };
  return d;
}

export async function peekUsage(repo: Repository, ctx: { principalId: string; ipHash: string }, kind: UsageKind, ent: Entitlements): Promise<UsageDecision> {
  const { limit, ipLimit, windowSeconds } = limitsFor(kind, ent);
  const since = new Date(Date.now() - windowSeconds * 1000);
  const c = await repo.countUsage(kind, ctx.principalId, ctx.ipHash, since);
  return decide(kind, ent, c, c.byPrincipal < limit && c.byIp < ipLimit, false);
}
