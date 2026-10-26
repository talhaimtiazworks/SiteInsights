import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authPreflight: vi.fn(),
  requireAccount: vi.fn(),
  readJson: vi.fn(),
  getMembership: vi.fn(),
  listOrganizations: vi.fn(),
  getProfile: vi.fn(),
  createInvitation: vi.fn(),
  updateInvitationEmailStatus: vi.fn(),
  listInvitations: vi.fn(),
  revokeInvitation: vi.fn(),
  invitationEmailNotConfigured: {
    status: "not_configured" as const,
    errorCode: "email_not_configured" as const,
    message: "The invitation is saved, but team email is not configured. The recipient can accept or decline it from the Invitation inbox in Teams.",
  },
}));
vi.mock("@/lib/auth/route-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/route-helpers")>();
  return { ...actual, authPreflight: mocks.authPreflight };
});
vi.mock("@/lib/services/account", () => ({ requireAccount: mocks.requireAccount }));
vi.mock("@/lib/http/api", () => ({
  ApiError: class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } },
  ok: (data: unknown, init?: ResponseInit) => new Response(JSON.stringify({ ok: true, data }), { status: init?.status ?? 200, headers: { "content-type": "application/json" } }),
  readJson: mocks.readJson,
  route: (handler: (req: NextRequest, context: never) => Promise<Response>) => handler,
}));
vi.mock("@/lib/services/organization-invitation-email", () => ({ ORGANIZATION_INVITATION_EMAIL_NOT_CONFIGURED: mocks.invitationEmailNotConfigured }));

import { POST as createInvitation } from "@/app/api/organizations/[orgId]/invitations/route";
import { POST as resendInvitation } from "@/app/api/organizations/[orgId]/invitations/[invitationId]/resend/route";
import { DELETE as revokeInvitation } from "@/app/api/organizations/[orgId]/invitations/[invitationId]/route";
import { POST as directMemberAdd } from "@/app/api/organizations/[orgId]/members/route";

const USER_ID = "11111111-2222-4333-8444-555555555555";
const ORG_ID = "22222222-3333-4444-8555-666666666666";
const INVITATION_ID = "33333333-4444-4555-8666-777777777777";
const user = { id: USER_ID, email: "owner@example.test", displayName: "Owner" };
const invitation = {
  id: INVITATION_ID,
  email: "invitee@example.test",
  role: "member" as const,
  status: "pending" as const,
  createdAt: "2026-10-22T00:00:00.000Z",
  expiresAt: "2026-10-29T00:00:00.000Z",
  emailDeliveryStatus: "not_configured" as const,
  emailLastAttemptAt: null,
  emailErrorCode: "email_not_configured",
};
const context = { params: Promise.resolve({ orgId: ORG_ID, invitationId: INVITATION_ID }) };

function request(url: string, body?: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAccount.mockResolvedValue({ user, accounts: {
    getMembership: mocks.getMembership,
    listOrganizations: mocks.listOrganizations,
    getProfile: mocks.getProfile,
    createInvitation: mocks.createInvitation,
    updateInvitationEmailStatus: mocks.updateInvitationEmailStatus,
    listInvitations: mocks.listInvitations,
    revokeInvitation: mocks.revokeInvitation,
    resendInvitation: vi.fn(),
  } });
  mocks.getMembership.mockResolvedValue("owner");
  mocks.listOrganizations.mockResolvedValue([{ id: ORG_ID, name: "Example team", role: "owner", memberCount: 1 }]);
  mocks.getProfile.mockResolvedValue({ email: "owner@example.test", displayName: "Owner" });
  mocks.readJson.mockResolvedValue({ email: "invitee@example.test", role: "member" });
  mocks.createInvitation.mockResolvedValue({ outcome: "created", invitation });
  mocks.listInvitations.mockResolvedValue([invitation]);
  mocks.revokeInvitation.mockResolvedValue("revoked");
});

describe("organization invitation routes", () => {
  it("creates a pending invitation for existing or new addresses without adding a member", async () => {
    const response = await createInvitation(request(`https://siteinsight.example/api/organizations/${ORG_ID}/invitations`, { email: "invitee@example.test", role: "member" }), context as never);
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.data.invitation.status).toBe("pending");
    expect(body.data.emailDelivery.status).toBe("not_configured");
    expect(mocks.createInvitation).toHaveBeenCalledOnce();
    const input = mocks.createInvitation.mock.calls[0][0];
    expect(input.email).toBe("invitee@example.test");
    expect(input.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(input.tokenHash).not.toBe("a".repeat(43));
    expect(body.data).not.toHaveProperty("token");
    expect(body.data).not.toHaveProperty("invitationUrl");
    expect(input.emailDeliveryStatus).toBe("not_configured");
    expect(input.emailErrorCode).toBe("email_not_configured");
    expect(body.data.invitation.emailDeliveryStatus).toBe("not_configured");
    expect(body.data.invitation.emailErrorCode).toBe("email_not_configured");
    expect(mocks.updateInvitationEmailStatus).not.toHaveBeenCalled();
  });

  it("does not create an invitation when a regular member tries to invite", async () => {
    mocks.getMembership.mockResolvedValue("member");
    await expect(createInvitation(request(`https://siteinsight.example/api/organizations/${ORG_ID}/invitations`, { email: "invitee@example.test", role: "member" }), context as never)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });

  it("allows only owners to grant admin role", async () => {
    mocks.getMembership.mockResolvedValue("admin");
    mocks.readJson.mockResolvedValue({ email: "invitee@example.test", role: "admin" });
    await expect(createInvitation(request(`https://siteinsight.example/api/organizations/${ORG_ID}/invitations`, { email: "invitee@example.test", role: "admin" }), context as never)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });

  it("allows an admin to create a member invitation but never an admin invitation", async () => {
    mocks.getMembership.mockResolvedValue("admin");
    const response = await createInvitation(request(`https://siteinsight.example/api/organizations/${ORG_ID}/invitations`, { email: "invitee@example.test", role: "member" }), context as never);
    expect(response.status).toBe(201);
    expect(mocks.createInvitation).toHaveBeenCalledOnce();
    mocks.createInvitation.mockClear();
    mocks.readJson.mockResolvedValue({ email: "invitee@example.test", role: "admin" });
    await expect(createInvitation(request(`https://siteinsight.example/api/organizations/${ORG_ID}/invitations`, { email: "invitee@example.test", role: "admin" }), context as never)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });

  it("enforces member capacity and existing-membership conflicts at invitation creation", async () => {
    mocks.createInvitation.mockResolvedValueOnce({ outcome: "member_limit", invitation: null });
    await expect(createInvitation(request(`https://siteinsight.example/api/organizations/${ORG_ID}/invitations`, { email: "invitee@example.test", role: "member" }), context as never)).rejects.toMatchObject({ status: 409, code: "member_limit" });
    mocks.createInvitation.mockResolvedValueOnce({ outcome: "member_exists", invitation: null });
    await expect(createInvitation(request(`https://siteinsight.example/api/organizations/${ORG_ID}/invitations`, { email: "invitee@example.test", role: "member" }), context as never)).rejects.toMatchObject({ status: 409, code: "already_member" });
  });

  it("rejects resend without mutation when email is unconfigured, and checks the manager role first", async () => {
    await expect(resendInvitation(request(`https://siteinsight.example/api/organizations/${ORG_ID}/invitations/${INVITATION_ID}/resend`, {}), context as never)).rejects.toMatchObject({ status: 503, code: "email_not_configured" });
    expect(mocks.listInvitations).toHaveBeenCalledWith(ORG_ID);
    expect(mocks.createInvitation).not.toHaveBeenCalled();
    expect(mocks.updateInvitationEmailStatus).not.toHaveBeenCalled();
    mocks.getMembership.mockResolvedValue("member");
    await expect(resendInvitation(request(`https://siteinsight.example/api/organizations/${ORG_ID}/invitations/${INVITATION_ID}/resend`, {}), context as never)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(mocks.listInvitations).toHaveBeenCalledOnce();
  });

  it("lets a manager revoke a pending invitation but blocks regular members", async () => {
    const response = await revokeInvitation(request(`https://siteinsight.example/api/organizations/${ORG_ID}/invitations/${INVITATION_ID}`, undefined), context as never);
    expect(response.status).toBe(200);
    expect(mocks.revokeInvitation).toHaveBeenCalledExactlyOnceWith(ORG_ID, INVITATION_ID, USER_ID);
    mocks.revokeInvitation.mockClear();
    mocks.getMembership.mockResolvedValue("member");
    await expect(revokeInvitation(request(`https://siteinsight.example/api/organizations/${ORG_ID}/invitations/${INVITATION_ID}`, undefined), context as never)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(mocks.revokeInvitation).not.toHaveBeenCalled();
  });

  it("blocks legacy direct member additions even for an authorized team manager", async () => {
    await expect(directMemberAdd(request(`https://siteinsight.example/api/organizations/${ORG_ID}/members`, { userId: "44444444-5555-4666-8777-888888888888", role: "member" }), context as never)).rejects.toMatchObject({ status: 410, code: "invitation_required" });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
    expect(mocks.listOrganizations).not.toHaveBeenCalled();
  });

  it("checks direct-add authorization before returning the invitation-only response", async () => {
    mocks.getMembership.mockResolvedValue(null);
    await expect(directMemberAdd(request(`https://siteinsight.example/api/organizations/${ORG_ID}/members`, { userId: "44444444-5555-4666-8777-888888888888", role: "member" }), context as never)).rejects.toMatchObject({ status: 404, code: "organization_not_found" });
    mocks.getMembership.mockResolvedValue("member");
    await expect(directMemberAdd(request(`https://siteinsight.example/api/organizations/${ORG_ID}/members`, { userId: "44444444-5555-4666-8777-888888888888", role: "member" }), context as never)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });
});
