import type { NextRequest } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config/env";
import { getRepository } from "@/lib/db";
import { assertSameOrigin, ok, readJson, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { processInBackground } from "@/lib/services/background";
import { createBatch } from "@/lib/services/batches";
import { dashboardAccess } from "@/lib/services/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({ urls: z.array(z.string().max(2048)).min(1).max(50), maxPages: z.number().int().min(1).max(10_000).optional() }).strict();

/** Queue several audits at once (Business plan). Each item is started through the normal audit checks. */
export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  throttle(req, ctx, "batch:create", 5);
  const body = schema.parse(await readJson(req, 65_536));
  const res = await createBatch(ctx, { urls: body.urls, maxPages: body.maxPages ?? null });
  for (const id of res.started) processInBackground(req.nextUrl.origin, id);
  return ok({ batch: res.batch, maxCost: res.maxCost }, { status: 201 });
});

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  throttle(req, ctx);
  const principalId = await dashboardAccess(ctx);
  const batches = await getRepository().commerce.listBatches(principalId, 20);
  return ok({ batches: batches.map((b) => ({ id: b.id, createdAt: b.createdAt, items: b.items })) });
});
