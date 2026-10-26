import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { siteOrigin } from "../auth/route-helpers";
import { isHttps } from "../http/session";

export const ORGANIZATION_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ORGANIZATION_INVITATION_COOKIE = "si_team_invitation";
const HASH_RE = /^[a-f0-9]{64}$/;

export function createInvitationToken() {
  return randomBytes(32).toString("base64url");
}

export function hashInvitationToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** The bearer token stays in the fragment; browsers do not send fragments to app/proxy access logs. */
export function organizationInvitationUrl(req: NextRequest, token: string) {
  const url = new URL("/teams/invitation", siteOrigin(req));
  url.hash = new URLSearchParams({ invite: token }).toString();
  return url.toString();
}

/** After the link is opened, only its hash is kept in a short-lived, HttpOnly API-scoped cookie. */
export function invitationCookieOptions(req: NextRequest, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isHttps(req),
    path: "/api/organizations/invitations",
    maxAge: Math.max(0, Math.min(Math.floor(maxAge), ORGANIZATION_INVITATION_TTL_MS / 1000)),
  };
}

export function invitationHashFromRequest(req: NextRequest): string | null {
  const value = req.cookies.get(ORGANIZATION_INVITATION_COOKIE)?.value ?? null;
  return value && HASH_RE.test(value) ? value : null;
}
