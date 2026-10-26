import type { NextRequest } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config/env";
import { ApiError, assertSameOrigin, ok, readJson, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { deleteProspect, getProspect, prospectPatchSchema, updateProspect } from "@/lib/services/prospects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function prospectId(id: string) {
  if (!z.uuid().safeParse(id).success) throw new ApiError(404, "not_found", "Prospect not found.");
  return id;
}

export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  throttle(req, ctx);
  return ok({ prospect: await getProspect(ctx, prospectId((await params).id)) });
});

/** Updates owner-held prospect details or explicit team sharing/assignment under current membership and plan checks. */
export const PATCH = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  throttle(req, ctx, "prospects:write", 120);
  const id = prospectId((await params).id);
  const body = prospectPatchSchema.parse(await readJson(req));
  return ok({ prospect: await updateProspect(ctx, id, body) });
});

export const DELETE = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  throttle(req, ctx, "prospects:write", 120);
  const id = prospectId((await params).id);
  await deleteProspect(ctx, id);
  return ok({ deleted: true, id });
});
