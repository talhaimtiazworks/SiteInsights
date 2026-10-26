import type { NextRequest } from "next/server";
import { getRepository } from "@/lib/db";
import { assertScanId, ok, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { loadScanAccess } from "@/lib/services/scans";
import { pageSummary } from "@/lib/services/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Discovered/crawled pages. `?detail=full` includes headings, links and images. */
export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  const { id } = await params;
  assertScanId(id);
  throttle(req, ctx);
  const repo = getRepository();
  await loadScanAccess(repo, id, ctx, "read");
  const pages = await repo.listPages(id);
  const full = req.nextUrl.searchParams.get("detail") === "full";
  return ok({ pages: full ? pages : pages.map(pageSummary), count: pages.length });
});
