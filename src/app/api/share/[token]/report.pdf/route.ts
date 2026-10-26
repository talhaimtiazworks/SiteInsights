import type { NextRequest } from "next/server";
import { getRepository } from "@/lib/db";
import { ApiError, route } from "@/lib/http/api";
import { getRequestContext, throttle } from "@/lib/http/context";
import { auditPdfResponse } from "@/lib/services/report-pdf";
import { entitlementsForPrincipal } from "@/lib/services/plan";
import { resolveShare } from "@/lib/services/shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** PDF of a shared report. Metered against the report owner's PDF allowance. */
export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const ctx = await getRequestContext(req);
  throttle(req, ctx, "share:pdf", 10);
  const { share, scan, snapshot } = await resolveShare((await params).token);
  if (!share.allowPdf) throw new ApiError(403, "pdf_not_shared", "The owner did not include the PDF with this link.");
  const ent = await entitlementsForPrincipal(share.principalId);
  const res = await auditPdfResponse(getRepository(), scan, { canEdit: false, viaOrganization: false }, { principalId: share.principalId, ipHash: ctx.ipHash }, ent, { shared: true, snapshot });
  return res;
});
