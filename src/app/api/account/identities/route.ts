import type { NextRequest } from "next/server";
import { authError } from "@/lib/auth/errors";
import { getAuthProviders } from "@/lib/auth/providers";
import { requireUser, supabaseForRequest } from "@/lib/auth/server";
import { ok, route } from "@/lib/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sign-in methods connected to this account, plus which ones could be connected. */
export const GET = route(async (req: NextRequest) => {
  const user = await requireUser(req);
  const { data, error } = await supabaseForRequest(req).auth.getUserIdentities();
  if (error) throw authError(error, "identities");
  const providers = await getAuthProviders();
  const identities = (data?.identities ?? []).map((i) => ({
    identityId: i.identity_id,
    provider: i.provider,
    email: typeof i.identity_data?.email === "string" ? i.identity_data.email : null,
    createdAt: i.created_at ?? null,
    lastSignInAt: i.last_sign_in_at ?? null,
  }));
  return ok({ identities, available: { google: providers.google, github: providers.github }, isSso: user.isSso, hasPassword: user.providers.includes("email") });
});
