import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AIProviderError } from "../ai/errors";
import { createUserProvider } from "../ai/registry";
import { explainFinding, summarizeAudit } from "../ai/service";
import { getConfig } from "../config/env";
import { getRepository } from "../db";
import { ApiError } from "../http/api";
import type { RequestContext } from "../http/context";
import { hasResults } from "../scans/state-machine";
import { consumeUsage } from "../usage/meter";
import { entitlementsFor, loadOwnedScan } from "./scans";

/**
 * Strict BYOK request contract. Every AI operation REQUIRES the caller's own
 * provider + key. There is no server key and no fallback: the key is used to
 * build ONE request-scoped provider instance and is never persisted, logged,
 * or returned in responses.
 */
export const aiRequestSchema = z.object({
  provider: z.enum(["openrouter", "gemini"]),
  apiKey: z.string().trim().min(8, "Paste your full provider API key.").max(300),
  regenerate: z.boolean().optional().default(false),
});
export type AiRequestBody = z.infer<typeof aiRequestSchema>;

/**
 * Parses the BYOK request body with a user-actionable failure: a missing key
 * is a 400 "ai_key_required" (points at AI settings), other shape problems are
 * a 400 "ai_request_invalid". Never fails open, never echoes the key.
 */
export function parseAiRequest(raw: unknown): AiRequestBody {
  const r = aiRequestSchema.safeParse(raw);
  if (r.success) return r.data;
  const missingKey = r.error.issues.some((i) => i.path[0] === "apiKey");
  if (missingKey) {
    throw new ApiError(400, "ai_key_required", "AI features run on your own provider key. Connect one on the AI settings page — it stays in this session's memory and is never stored.");
  }
  throw new ApiError(400, "ai_request_invalid", "The AI request is invalid: provide a supported provider and a valid API key.");
}

/**
 * Order of operations for every AI request:
 *  1. authentication (getAuditContext, done by the route) + ownership + completed-scan checks
 *  2. return cached result if present (no cost, no key consumed)
 *  3. request-scoped provider construction from the supplied key (fails fast — nothing consumed)
 *  4. abuse-limit check & record (BEFORE any provider call)
 *  5. provider call with bounded retries; usage refunded if the call fails
 */
async function prepare(ctx: RequestContext, scanId: string, body: AiRequestBody, findingId: string | null) {
  const repo = getRepository();
  const scan = await loadOwnedScan(repo, scanId, ctx);
  if (!hasResults(scan.status)) throw new ApiError(409, "results_unavailable", "AI analysis is only available for completed scans.");
  const cached = await repo.getAiRecommendation(scanId, findingId);
  return { repo, scan, cached: body.regenerate ? null : cached };
}

/**
 * Technical abuse limits BEFORE any provider call (rolling windows + burst).
 * No plan feature check and no credit charge: AI assistance is a normal, free
 * feature — the provider usage itself is billed to the USER's provider account,
 * because it runs on the user's own key.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the payload defines the call contract with its callers.
async function meter(ctx: RequestContext, _op: { kind: "explanation" | "summary"; scanId: string; target: string; requestKey: string | null }) {
  const repo = getRepository();
  const ent = await entitlementsFor(ctx);
  await repo.ensurePrincipal(ctx.principalId, ctx.ipHash);
  const usage = await consumeUsage(repo, ctx, "ai_request", ent);
  if (!usage.allowed && usage.limitedBy === "burst") {
    throw new ApiError(429, "ai_burst_limited", `You can make up to ${ent.aiBurstLimit} AI requests every ${Math.max(1, Math.round(ent.aiBurstWindowSeconds / 60))} minute(s). Please wait a moment.`, { resetAt: usage.resetAt });
  }
  if (!usage.allowed) throw new ApiError(429, "ai_limit_reached", "You have hit the AI request limit for this window. Please try again a little later.", { resetAt: usage.resetAt, limit: usage.limit });
  const refund = async () => {
    await repo.refundUsage("ai_request", ctx.principalId, ctx.ipHash).catch(() => {});
  };
  return { ent, refund };
}

export async function explainFindingForUser(ctx: RequestContext, scanId: string, findingId: string, body: AiRequestBody, requestKey: string | null = null) {
  const { repo, scan, cached } = await prepare(ctx, scanId, body, findingId);
  const finding = await repo.getFinding(scanId, findingId);
  if (!finding) throw new ApiError(404, "finding_not_found", "Issue not found.");
  if (cached) return { record: cached, cached: true };
  const cfg = getConfig();
  // Request-scoped provider: constructed locally, used once below, then discarded.
  const provider = createUserProvider(cfg.ai, body.provider, body.apiKey, cfg.appUrl);
  const { ent, refund } = await meter(ctx, { kind: "explanation", scanId, target: findingId, requestKey });
  try {
    const pages = await repo.listPages(scanId);
    const page = pages.find((p) => p.finalUrl === finding.affectedUrl || p.url === finding.affectedUrl);
    const { explanation, meta } = await explainFinding(provider, scan, finding, page, { maxInputChars: ent.maxAiInputChars, maxOutputTokens: cfg.ai.maxOutputTokens, maxRetries: cfg.ai.maxRetries });
    const record = { id: randomUUID(), scanId, findingId, provider: meta.provider, model: meta.model, fallbackFrom: meta.fallbackFrom, content: { ...explanation }, createdAt: new Date().toISOString() };
    await repo.saveAiRecommendation(record);
    return { record, cached: false };
  } catch (err) {
    await refund();
    throw err;
  }
}

export async function summarizeForUser(ctx: RequestContext, scanId: string, body: AiRequestBody, requestKey: string | null = null) {
  const { repo, scan, cached } = await prepare(ctx, scanId, body, null);
  if (cached) return { record: cached, cached: true };
  const findings = await repo.listFindings(scanId);
  const cfg = getConfig();
  const provider = createUserProvider(cfg.ai, body.provider, body.apiKey, cfg.appUrl);
  const { ent, refund } = await meter(ctx, { kind: "summary", scanId, target: "summary", requestKey });
  try {
    const { summary, meta } = await summarizeAudit(provider, scan, findings, { maxInputChars: ent.maxAiInputChars, maxOutputTokens: cfg.ai.maxOutputTokens, maxRetries: cfg.ai.maxRetries });
    const record = { id: randomUUID(), scanId, findingId: null, provider: meta.provider, model: meta.model, fallbackFrom: meta.fallbackFrom, content: { ...summary }, createdAt: new Date().toISOString() };
    await repo.saveAiRecommendation(record);
    return { record, cached: false };
  } catch (err) {
    await refund();
    throw err;
  }
}

export { AIProviderError };
