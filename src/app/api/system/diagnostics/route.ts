import type { NextRequest } from "next/server";
import { getConfig } from "@/lib/config/env";
import { ApiError, ok, route } from "@/lib/http/api";
import { isAuthorizedCron } from "@/lib/services/background";
import { runDiagnostics } from "@/lib/services/diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Operator diagnostics: live database, migration, Auth, project-match, worker,
 * PageSpeed and AI checks with a corrective action for each problem.
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR-APP/api/system/diagnostics
 * Variable values are never returned — only names, "set"/"unset" and problem codes.
 */
export const GET = route(async (req: NextRequest) => {
  if (!getConfig().background.cronSecret) {
    throw new ApiError(503, "diagnostics_need_cron_secret", "Set CRON_SECRET (16+ characters) to enable diagnostics, then call this endpoint with Authorization: Bearer <CRON_SECRET>.");
  }
  if (!isAuthorizedCron(req.headers.get("authorization"))) throw new ApiError(401, "unauthorized", "Send Authorization: Bearer <CRON_SECRET>.");
  return ok(await runDiagnostics());
});
