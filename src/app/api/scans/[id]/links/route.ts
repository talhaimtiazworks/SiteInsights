import type { NextRequest } from "next/server";
import { z } from "zod";
import { getRepository } from "@/lib/db";
import { assertScanId, ok, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { loadScanAccess } from "@/lib/services/scans";
import { BROKEN_CATEGORIES, INCONCLUSIVE_CATEGORIES } from "@/lib/scanner/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(["all", "broken", "inconclusive", "redirect", "ok", "not_checked"]).default("all"),
  scope: z.enum(["all", "internal", "external"]).default("all"),
  kind: z.enum(["all", "page_link", "image"]).default("all"),
});

/** Checked links, filterable by status, scope and kind. `?status=broken` lists broken links. */
export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  const { id } = await params;
  assertScanId(id);
  throttle(req, ctx);
  const q = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  const repo = getRepository();
  await loadScanAccess(repo, id, ctx, "read");
  let links = await repo.listLinkChecks(id);
  if (q.status === "broken") links = links.filter((l) => BROKEN_CATEGORIES.includes(l.category));
  else if (q.status === "inconclusive") links = links.filter((l) => INCONCLUSIVE_CATEGORIES.includes(l.category));
  else if (q.status === "redirect") links = links.filter((l) => l.category === "redirect");
  else if (q.status === "ok") links = links.filter((l) => l.category === "ok");
  else if (q.status === "not_checked") links = links.filter((l) => l.verification === "not_checked");
  if (q.scope !== "all") links = links.filter((l) => l.internal === (q.scope === "internal"));
  if (q.kind !== "all") links = links.filter((l) => l.kind === q.kind);
  return ok({ links, count: links.length });
});
