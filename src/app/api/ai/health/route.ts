import type { NextRequest } from "next/server";
import { z } from "zod";
import { createUserProvider } from "@/lib/ai/registry";
import { getConfig } from "@/lib/config/env";
import { assertSameOrigin, ok, readJson, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  provider: z.enum(["openrouter", "gemini"]),
  apiKey: z.string().trim().min(8, "Paste your full provider API key.").max(300),
});

/**
 * "Test connection": a genuine provider request using the CALLER's own key
 * (OpenRouter: GET /key — validates the credential without generating tokens;
 * Gemini: GET models/{model} — validates the key AND the default model).
 * Request-scoped only: the key never persists, is never logged, and the
 * response (through `ok()`) is `Cache-Control: no-store`.
 */
export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req, getConfig().appUrl);
  const ctx = await getAuditContext(req);
  throttle(req, ctx, "ai:health", 6);
  const { provider, apiKey } = schema.parse(await readJson(req));
  const cfg = getConfig();
  const scoped = createUserProvider(cfg.ai, provider, apiKey, cfg.appUrl);
  const health = await scoped.healthCheck();
  return ok(health);
});
