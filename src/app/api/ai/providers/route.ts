import type { NextRequest } from "next/server";
import { getRepository, storageInfo, StorageNotConfiguredError } from "@/lib/db";
import { ok, route } from "@/lib/http/api";
import { getRequestContext, throttle } from "@/lib/http/context";
import { aiProviderSupport } from "@/lib/services/scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which AI providers users may connect with their own keys (metadata only —
 * never credentials, and no longer any notion of "server configured").
 */
/**
 * Which AI providers users may connect with their own keys (metadata only —
 * never credentials, and no longer any notion of "server configured").
 * Degrades gracefully when the database is unavailable: the static provider
 * list is still served (BYOK needs nothing stored), the optional preference
 * is then null — the settings page must remain usable during a DB blip.
 */
export const GET = route(async (req: NextRequest) => {
  const ctx = await getRequestContext(req);
  throttle(req, ctx);
  let preference: "openrouter" | "gemini" | null = null;
  let preferencePersistent = false;
  try {
    const repo = getRepository();
    preference = await repo.getProviderPreference(ctx.principalId);
    preferencePersistent = storageInfo().persistent;
  } catch (err) {
    if (!(err instanceof StorageNotConfiguredError)) throw err;
  }
  return ok({ providers: aiProviderSupport(), userPreference: preference, preferencePersistent });
});
