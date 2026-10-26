import type { NextRequest } from "next/server";
import { authPreflight } from "@/lib/auth/route-helpers";
import { ok, readJson, route } from "@/lib/http/api";
import { requireAccount } from "@/lib/services/account";
import { loadProfessionalData, saveProfessionalData } from "@/lib/services/professional-profile";
import { MAX_PROFESSIONAL_PROFILE_BODY_BYTES } from "@/lib/professional/logo-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Private profile, services and portfolio settings for the signed-in owner. */
export const GET = route(async (req: NextRequest) => {
  const { user, accounts } = await requireAccount(req);
  return ok({ professional: await loadProfessionalData(accounts, user.id) });
});

/** Replaces only the authenticated owner's validated professional-profile data. */
export const PUT = route(async (req: NextRequest) => {
  authPreflight(req, "professional-profile", 20);
  const { user, accounts } = await requireAccount(req);
  // One MiB raw logos expand to ~1.4 MiB in a data URI; the second MiB is a
  // hard ceiling for the validated profile/services/portfolio JSON around it.
  const body = await readJson(req, MAX_PROFESSIONAL_PROFILE_BODY_BYTES);
  return ok({ professional: await saveProfessionalData(accounts, user.id, body) });
});
