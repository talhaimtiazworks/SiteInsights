import type { NextRequest } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config/env";
import { getRepository } from "@/lib/db";
import { ApiError, assertSameOrigin, ok, readJson, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { processInBackground } from "@/lib/services/background";
import { startScan, toPublicScan } from "@/lib/services/scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The response returns immediately; background processing continues for up to BACKGROUND_BUDGET_MS + one step.
export const maxDuration = 300;

const startSchema = z.object({
  url: z.string().min(1).max(2048),
  checks: z.object({ browser: z.boolean().optional(), accessibility: z.boolean().optional(), performance: z.boolean().optional() }).strict().optional(),
  /** Optional smaller page limit chosen by the user (validated against the plan on the server). */
  maxPages: z.number().int().min(1).max(10_000).optional(),
}).strict(); // unknown fields (e.g. a client-supplied plan or credit amount) are rejected, never trusted

/** Start a new scan. */
export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  throttle(req, ctx, "scan:start", 10);
  const body = startSchema.parse(await readJson(req));
  const idem = req.headers.get("idempotency-key");
  if (idem !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(idem)) {
    throw new ApiError(400, "invalid_idempotency_key", "The Idempotency-Key header must be 8–64 letters, digits, '-' or '_'.");
  }
  const { scan, accessKey, replayed } = await startScan(ctx, body.url, { idempotencyKey: idem, checks: body.checks, maxPages: body.maxPages ?? null });
  // Keep working on the audit after responding, so it finishes even if the tab is closed.
  if (!replayed) processInBackground(req.nextUrl.origin, scan.id);
  // 201 for a new scan; 200 when a retried request returns the original scan.
  return ok({ ...toPublicScan(scan), accessKey }, { status: replayed ? 200 : 201 });
});

/** List the caller's recent scans. */
export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  throttle(req, ctx);
  const limit = Math.min(50, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? 20) || 20));
  const scans = await getRepository().listScans(ctx.principalId, limit);
  return ok({ scans: scans.map((s) => toPublicScan(s)) });
});
