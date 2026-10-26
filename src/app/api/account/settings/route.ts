import type { NextRequest } from "next/server";
import { z } from "zod";
import { authPreflight } from "@/lib/auth/route-helpers";
import { ok, readJson, route } from "@/lib/http/api";
import { requireAccount } from "@/lib/services/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const { user, accounts } = await requireAccount(req);
  return ok({ settings: await accounts.getUserSettings(`user:${user.id}`) });
});

const schema = z.object({ theme: z.enum(["system", "light", "dark"]).optional(), defaultBrowser: z.boolean().optional(), defaultPerformance: z.boolean().optional() }).strict();

export const PATCH = route(async (req: NextRequest) => {
  authPreflight(req, "settings", 30);
  const { user, accounts } = await requireAccount(req);
  const body = schema.parse(await readJson(req));
  return ok({ settings: await accounts.updateUserSettings(`user:${user.id}`, body) });
});
