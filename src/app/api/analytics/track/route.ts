import "server-only";
import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { classifySource, sanitizePath, sanitizeReferrerHost, uaBrowser, uaDevice, uaOs } from "@/lib/analytics/classify";
import { getConfig } from "@/lib/config/env";
import { getRepository } from "@/lib/db";
import { readJson, route } from "@/lib/http/api";
import { getRequestContext, throttle } from "@/lib/http/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public first-party analytics intake.
 *
 * Privacy contract (docs/ANALYTICS.md):
 *  - only allowlisted properties are accepted (strict zod schema);
 *  - the client strips all query strings client-side and sends at most the
 *    three utm_* parameters; the server re-sanitizes everything anyway;
 *  - visitor/session ids are replaced by salted HMAC hashes before storage;
 *    raw ids and IP addresses are never persisted;
 *  - bot user agents are not stored;
 *  - failures are swallowed AFTER logging so tracking can never break the UX.
 */
const bodySchema = z
  .object({
    eventId: z.string().uuid(),
    visitorId: z.string().uuid(),
    sessionId: z.string().uuid(),
    eventType: z.enum(["pageview", "session_start"]),
    path: z.string().min(1).max(400),
    referrer: z.string().max(2048).nullable().optional(),
    utmSource: z.string().max(120).nullable().optional(),
    utmMedium: z.string().max(120).nullable().optional(),
    utmCampaign: z.string().max(120).nullable().optional(),
    language: z.string().max(16).nullable().optional(),
  })
  .strict();

function hashId(kind: string, id: string): string {
  // SESSION_SECRET is shared with the IP-hash convention; a per-kind domain
  // separator prevents cross-linking visitor hashes with session hashes.
  return createHmac("sha256", getConfig().sessionSecret ?? "sitelens-analytics-default-salt")
    .update(`${kind}:${id}`)
    .digest("hex")
    .slice(0, 32);
}

function isBotUa(ua: string): boolean {
  return /bot|crawler|spider|slurp|curl|wget|python-requests|headlesschrome|lighthouse|pingdom|uptime/i.test(ua);
}

export const POST = route(async (req: NextRequest) => {
  const ctx = await getRequestContext(req);
  throttle(req, ctx, "analytics:track", 240);

  const body = bodySchema.parse(await readJson(req, 4_096));
  const ua = (req.headers.get("user-agent") ?? "").slice(0, 512);
  if (isBotUa(ua)) return new Response(null, { status: 204 });

  const path = sanitizePath(body.path);
  if (!path) return new Response(null, { status: 204 }); // excluded area (admin/api/auth…) — silently skipped

  const referrerHost = sanitizeReferrerHost(body.referrer ?? null);
  const ownHost = req.nextUrl.host.toLowerCase();
  let source = classifySource({
    referrerHost,
    ownHost,
    utmSource: body.utmSource ?? null,
    utmMedium: body.utmMedium ?? null,
  });
  const visitorHash = hashId("visitor", body.visitorId);
  const sessionHash = hashId("session", body.sessionId);
  if (source === "direct" || !referrerHost || referrerHost === ownHost) {
    // In-session pageview (or same-site referrer): inherit the session's first
    // recorded source so attribution stays session-scoped, as documented.
    try {
      const prior = await getRepository().analytics.sessionSource(sessionHash);
      if (prior && prior !== "direct") source = prior;
    } catch {
      /* attribution fallthrough is not fatal */
    }
  }

  try {
    await getRepository().analytics.insertEvent({
      clientEventId: body.eventId,
      visitorHash,
      sessionHash,
      eventType: body.eventType,
      path,
      referrerHost: referrerHost && referrerHost !== ownHost ? referrerHost : null,
      source,
      device: uaDevice(ua),
      browser: uaBrowser(ua),
      os: uaOs(ua),
    });
  } catch (err) {
    // Never surface tracking failures to visitors; dedupe conflicts and DB
    // outages both resolve to a silent, logged no-op.
    console.error("analytics.track.persist_failed", err instanceof Error ? err.message : err);
  }
  return new Response(null, { status: 204 });
});
