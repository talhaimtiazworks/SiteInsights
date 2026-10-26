import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { createInvitationToken, hashInvitationToken, invitationCookieOptions, invitationHashFromRequest, ORGANIZATION_INVITATION_COOKIE, ORGANIZATION_INVITATION_TTL_MS, organizationInvitationUrl } from "@/lib/services/organization-invitations";

describe("organization invitation capabilities", () => {
  it("creates high-entropy URL-safe tokens and stores only a fixed-width hash", () => {
    const token = createInvitationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const hash = hashInvitationToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashInvitationToken(token)).toBe(hash);
    expect(hashInvitationToken(createInvitationToken())).not.toBe(hash);
  });

  it("sets a seven-day expiry window", () => {
    expect(ORGANIZATION_INVITATION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("keeps bearer tokens in the URL fragment and scopes the exchanged hash cookie to invitation APIs", () => {
    const token = createInvitationToken();
    const req = new NextRequest("https://siteinsight.example/teams/invitation");
    const url = new URL(organizationInvitationUrl(req, token));
    expect(url.pathname).toBe("/teams/invitation");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#invite=${token}`);
    expect(invitationCookieOptions(req, 3600)).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/api/organizations/invitations", maxAge: 3600 });
    expect(invitationCookieOptions(new NextRequest("http://localhost:3000/teams/invitation"), 99999999).maxAge).toBe(ORGANIZATION_INVITATION_TTL_MS / 1000);
  });

  it("accepts only a fixed-width token hash from the HttpOnly cookie", () => {
    const hash = hashInvitationToken(createInvitationToken());
    const valid = new NextRequest("https://siteinsight.example/api/organizations/invitations/preview", { headers: { cookie: `${ORGANIZATION_INVITATION_COOKIE}=${hash}` } });
    const invalid = new NextRequest("https://siteinsight.example/api/organizations/invitations/preview", { headers: { cookie: `${ORGANIZATION_INVITATION_COOKIE}=raw-bearer-token` } });
    expect(invitationHashFromRequest(valid)).toBe(hash);
    expect(invitationHashFromRequest(invalid)).toBeNull();
  });
});
