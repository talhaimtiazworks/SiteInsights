import type { Repository, UsageKind } from "../db/types";
import { logger } from "../logger";

/** Returns a previously consumed allowance; failures are logged, never thrown. */
export async function refundUsageSafe(repo: Repository, ctx: { principalId: string; ipHash: string }, kind: UsageKind) {
  try {
    await repo.refundUsage(kind, ctx.principalId, ctx.ipHash);
  } catch (err) {
    logger.warn("Usage refund failed", err);
  }
}
