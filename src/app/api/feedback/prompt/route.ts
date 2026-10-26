import type { NextRequest } from "next/server";
import { z } from "zod";
import { getAccountRepository } from "@/lib/db";
import { assertSameOrigin, ok, readJson, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { getConfig } from "@/lib/config/env";
import { getFeedbackPromptState, respondToFeedbackInvite } from "@/lib/services/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const respondSchema = z.object({ action: z.enum(["remind_later", "dismiss"]) }).strict();

/**
 * GET — invitation state for the signed-in account. Idempotent-safe (the
 * invitation row, when first created here, is INSERT ... ON CONFLICT DO NOTHING,
 * so concurrent reads/completions never duplicate the invitation).
 */
export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  throttle(req, ctx, "feedback:prompt:read", 30);
  const state = await getFeedbackPromptState(getAccountRepository(), ctx.user.id);
  return ok(state);
});

/** POST — the account's response to its own invitation (remind me later / dismiss). */
export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  throttle(req, ctx, "feedback:prompt:write", 30);
  const { action } = respondSchema.parse(await readJson(req));
  const result = await respondToFeedbackInvite(getAccountRepository(), ctx.user.id, action);
  if (!result.ok) return ok({ state: "unchanged" });
  return ok({ state: result.state });
});
