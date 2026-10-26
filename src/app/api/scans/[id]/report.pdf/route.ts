import type { NextRequest } from "next/server";
import { getRepository } from "@/lib/db";
import { assertScanId, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { auditPdfResponse } from "@/lib/services/report-pdf";
import { entitlementsFor, loadScanAccess } from "@/lib/services/scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Server-generated PDF of a completed audit. Same access rules as the results
 * API (owner or organization member). Requires a plan with PDF reports; counts
 * against the PDF-export allowance; a failed build is refunded and reported as
 * an error — an empty or partial file is never served.
 */
export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  const { id } = await params;
  assertScanId(id);
  throttle(req, ctx);
  const repo = getRepository();
  const { scan, viewer } = await loadScanAccess(repo, id, ctx, "read");
  const ent = await entitlementsFor(ctx);
  return auditPdfResponse(repo, scan, viewer, ctx, ent);
});
