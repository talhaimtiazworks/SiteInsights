import type { NextRequest } from "next/server";
import { authError } from "@/lib/auth/errors";
import { authPreflight } from "@/lib/auth/route-helpers";
import { requireUser, supabaseForRequest } from "@/lib/auth/server";
import { ApiError, ok, route } from "@/lib/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Disconnects a sign-in method. The last remaining method can't be removed. */
export const DELETE = route(async (req: NextRequest, { params }: { params: Promise<{ identityId: string }> }) => {
  authPreflight(req, "unlink", 10);
  await requireUser(req);
  const { identityId } = await params;
  const supabase = supabaseForRequest(req);
  const { data, error } = await supabase.auth.getUserIdentities();
  if (error) throw authError(error, "identities");
  const all = data?.identities ?? [];
  const identity = all.find((i) => i.identity_id === identityId);
  if (!identity) throw new ApiError(404, "identity_not_found", "That sign-in method isn't connected to your account.");
  if (all.length < 2) throw new ApiError(400, "last_identity", "You can't disconnect your only sign-in method.");
  const { error: e2 } = await supabase.auth.unlinkIdentity(identity);
  if (e2) throw authError(e2, "unlink");
  // Refresh the session so app_metadata.providers reflects the change.
  await supabase.auth.refreshSession().catch(() => {});
  return ok({ removed: true });
});
