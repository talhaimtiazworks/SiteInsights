import { getAuthProviders } from "@/lib/auth/providers";
import { ok, route } from "@/lib/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sign-in methods enabled on the Supabase project (only these get buttons). */
export const GET = route(async () => ok(await getAuthProviders()));
