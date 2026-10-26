import type { NextRequest } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config/env";
import { assertSameOrigin, assertScanId, ok, readJson, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { createShare, listShares, MAX_SHARE_DAYS } from "@/lib/services/shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  const { id } = await params;
  assertScanId(id);
  throttle(req, ctx);
  return ok(await listShares(ctx, id));
});

const schema = z.object({ expiresInDays: z.number().int().min(1).max(MAX_SHARE_DAYS).optional(), label: z.string().max(120).nullable().optional(), allowPdf: z.boolean().optional() }).strict();

/** Creates a read-only client link. The URL is returned once and cannot be recovered. Owner only, Business plan. */
export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  const { id } = await params;
  assertScanId(id);
  throttle(req, ctx, "share:create", 20);
  return ok(await createShare(ctx, id, schema.parse(await readJson(req)), req.nextUrl.origin), { status: 201 });
});
