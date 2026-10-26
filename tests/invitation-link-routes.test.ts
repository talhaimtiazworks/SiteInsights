import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashInvitationToken, ORGANIZATION_INVITATION_COOKIE } from "@/lib/services/organization-invitations";

const mocks = vi.hoisted(() => ({
  authPreflight: vi.fn(),
  readJson: vi.fn(),
  getInvitationPreview: vi.fn(),
  cookieSet: vi.fn(),
}));
vi.mock("@/lib/auth/route-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/route-helpers")>();
  return { ...actual, authPreflight: mocks.authPreflight };
});
vi.mock("@/lib/db", () => ({ getAccountRepository: () => ({ getInvitationPreview: mocks.getInvitationPreview }) }));
vi.mock("@/lib/http/api", () => ({
  ApiError: class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } },
  ok: (data: unknown) => {
    const response = new Response(JSON.stringify({ ok: true, data }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    Object.defineProperty(response, "cookies", { value: { set: mocks.cookieSet } });
    return response;
  },
  readJson: mocks.readJson,
  route: (handler: (req: NextRequest) => Promise<Response>) => handler,
}));

import { POST as prepare } from "@/app/api/organizations/invitations/prepare/route";
import { GET as preview } from "@/app/api/organizations/invitations/preview/route";

const rawToken = "z".repeat(43);
const previewData = {
  id: "11111111-2222-4333-8444-555555555555",
  organizationId: "22222222-3333-4444-8555-666666666666",
  organizationName: "Research team",
  email: "person@example.test",
  role: "admin" as const,
  status: "pending" as const,
  createdAt: "2026-10-21T12:00:00.000Z",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  invitedByName: "Team owner",
  invitedByEmail: "owner@example.test",
  emailDeliveryStatus: "not_configured" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readJson.mockResolvedValue({ token: rawToken });
  mocks.getInvitationPreview.mockResolvedValue(previewData);
});

describe("email-link invitation preparation and preview", () => {
  it("exchanges a fragment token for a short-lived API-only HttpOnly cookie and dynamic details", async () => {
    const req = new NextRequest("https://siteinsight.example/api/organizations/invitations/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: rawToken }) });
    const response = await prepare(req, {} as never);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.getInvitationPreview).toHaveBeenCalledExactlyOnceWith(hashInvitationToken(rawToken));
    expect(body.data.invitation).toMatchObject({ organizationName: "Research team", role: "admin", invitedByName: "Team owner", email: "person@example.test" });
    expect(JSON.stringify(body)).not.toContain(rawToken);
    expect(mocks.cookieSet).toHaveBeenCalledWith(ORGANIZATION_INVITATION_COOKIE, hashInvitationToken(rawToken), expect.objectContaining({ httpOnly: true, sameSite: "lax", secure: true, path: "/api/organizations/invitations", maxAge: expect.any(Number) }));
  });

  it("refuses invalid tokens before querying invitation data", async () => {
    mocks.readJson.mockResolvedValue({ token: "bad token" });
    await expect(prepare(new NextRequest("https://siteinsight.example/api/organizations/invitations/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "bad token" }) }), {} as never)).rejects.toMatchObject({ name: "ZodError" });
    expect(mocks.getInvitationPreview).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("clears rather than retains a cookie for an expired link", async () => {
    mocks.getInvitationPreview.mockResolvedValue({ ...previewData, status: "expired", expiresAt: "2026-01-01T00:00:00.000Z" });
    const response = await prepare(new NextRequest("https://siteinsight.example/api/organizations/invitations/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: rawToken }) }), {} as never);
    expect(response.status).toBe(200);
    expect(mocks.cookieSet).toHaveBeenCalledWith(ORGANIZATION_INVITATION_COOKIE, "", expect.objectContaining({ maxAge: 0 }));
  });

  it("requires the prepared hash cookie before returning dynamic preview details", async () => {
    await expect(preview(new NextRequest("https://siteinsight.example/api/organizations/invitations/preview"), {} as never)).rejects.toMatchObject({ status: 404, code: "invitation_not_found" });
    expect(mocks.getInvitationPreview).not.toHaveBeenCalled();

    const hash = hashInvitationToken(rawToken);
    const withCookie = await preview(new NextRequest("https://siteinsight.example/api/organizations/invitations/preview", { headers: { cookie: `${ORGANIZATION_INVITATION_COOKIE}=${hash}` } }), {} as never);
    const body = await withCookie.json();
    expect(withCookie.status).toBe(200);
    expect(body.data.invitation.organizationName).toBe("Research team");
    expect(mocks.getInvitationPreview).toHaveBeenCalledExactlyOnceWith(hash);
  });
});
