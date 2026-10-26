import type { NextRequest } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config/env";
import { getRepository, storageInfo, StorageNotConfiguredError } from "@/lib/db";
import { assertSameOrigin, ok, readJson, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { aiProviderSupport } from "@/lib/services/scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  throttle(req, ctx);
  let preference: "openrouter" | "gemini" | null = null;
  let persistent = false;
  try {
    preference = await getRepository().getProviderPreference(ctx.principalId);
    persistent = storageInfo().persistent;
  } catch (err) {
    if (!(err instanceof StorageNotConfiguredError)) throw err;
  }
  return ok({ preference, persistent, providers: aiProviderSupport() });
});

const schema = z
  .object({ provider: z.enum(["openrouter", "gemini"]).nullable() })
  .strict(); // BYOK: reject apiKey-shaped payloads — this endpoint stores preferences only, NEVER keys.

/**
 * Saves the caller's preferred provider — a UI convenience reference only.
 * No keys are accepted or stored: keys live exclusively in the user's browser
 * memory and travel with each AI request (strict BYOK).
 */
export const PUT = route(async (req: NextRequest) => {
  assertSameOrigin(req, getConfig().appUrl);
  const ctx = await getAuditContext(req);
  throttle(req, ctx, "settings", 20);
  const { provider } = schema.parse(await readJson(req));
  const repo = getRepository();
  await repo.ensurePrincipal(ctx.principalId, ctx.ipHash);
  await repo.setProviderPreference(ctx.principalId, provider);
  return ok({ preference: provider, persistent: storageInfo().persistent });
});
