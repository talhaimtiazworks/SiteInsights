import type { NextRequest } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config/env";
import { assertSameOrigin, ok, readJson, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { importManualProspects } from "@/lib/services/prospects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ csv: z.string().max(100_000) }).strict();

/** Imports only a user-supplied CSV of website/name/location values; no provider or crawling is involved. */
export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  throttle(req, ctx, "prospects:import", 10);
  const body = schema.parse(await readJson(req, 120_000));
  return ok(await importManualProspects(ctx, body.csv));
});
