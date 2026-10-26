import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashInvitationToken } from "@/lib/services/organization-invitations";

const mocks = vi.hoisted(() => ({
  authPreflight: vi.fn(),
  requireAccount: vi.fn(),
  requireConfirmedAccountEmail: vi.fn(),
  readJson: vi.fn(),
  acceptInvitation: vi.fn(),
  rejectInvitation: vi.fn(),
  acceptInvitationById: vi.fn(),
  rejectInvitationById: vi.fn(),
  listRecipientInvitations: vi.fn(),
  listOrganizations: vi.fn(),
  listMembersForUserOrganizations: vi.fn(),
}));
vi.mock("@/lib/auth/route-helpers", () => ({ authPreflight: mocks.authPreflight }));
vi.mock("@/lib/services/account", () => ({ requireAccount: mocks.requireAccount, requireConfirmedAccountEmail: mocks.requireConfirmedAccountEmail }));
vi.mock("@/lib/http/api", () => ({
  ApiError: class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } },
  ok: (data: unknown) => {
    const response = new Response(JSON.stringify({ ok: true, data }), { headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "cookies", { value: { set: () => undefined } });
    return response;
  },
  readJson: mocks.readJson,
  route: (handler: (req: NextRequest) => Promise<Response>) => handler,
}));

import { GET as listOrganizations } from "@/app/api/organizations/route";
import { POST as accept } from "@/app/api/organizations/invitations/accept/route";
import { POST as reject } from "@/app/api/organizations/invitations/reject/route";
import { GET as listRecipientInvitations } from "@/app/api/organizations/invitations/route";
import { POST as acceptById } from "@/app/api/organizations/invitations/[invitationId]/accept/route";
import { POST as rejectById } from "@/app/api/organizations/invitations/[invitationId]/reject/route";

const USER_ID = "11111111-2222-4333-8444-555555555555";
const user = { id: USER_ID, email: "unverified-jwt-claim@example.test" };
const rawToken = "a".repeat(43);
let accounts: {
  acceptInvitation: typeof mocks.acceptInvitation;
  rejectInvitation: typeof mocks.rejectInvitation;
  acceptInvitationById: typeof mocks.acceptInvitationById;
  rejectInvitationById: typeof mocks.rejectInvitationById;
  listRecipientInvitations: typeof mocks.listRecipientInvitations;
  listOrganizations: typeof mocks.listOrganizations;
  listMembersForUserOrganizations: typeof mocks.listMembersForUserOrganizations;
};

function invitationRequest() {
  return new NextRequest("https://siteinsight.example/api/organizations/invitations/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: rawToken }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  accounts = {
    acceptInvitation: mocks.acceptInvitation,
    rejectInvitation: mocks.rejectInvitation,
    acceptInvitationById: mocks.acceptInvitationById,
    rejectInvitationById: mocks.rejectInvitationById,
    listRecipientInvitations: mocks.listRecipientInvitations,
    listOrganizations: mocks.listOrganizations,
    listMembersForUserOrganizations: mocks.listMembersForUserOrganizations,
  };
  mocks.requireAccount.mockResolvedValue({ user, accounts });
  mocks.requireConfirmedAccountEmail.mockResolvedValue("verified@example.test");
  mocks.readJson.mockResolvedValue({ token: rawToken });
  mocks.acceptInvitation.mockResolvedValue("accepted");
  mocks.rejectInvitation.mockResolvedValue("rejected");
  mocks.acceptInvitationById.mockResolvedValue("accepted");
  mocks.rejectInvitationById.mockResolvedValue("rejected");
  mocks.listRecipientInvitations.mockResolvedValue([]);
  mocks.listOrganizations.mockResolvedValue([{ id: "org-1", name: "Example team", role: "owner" }]);
  mocks.listMembersForUserOrganizations.mockResolvedValue([{ organizationId: "org-1", userId: USER_ID, email: user.email, displayName: "Member", role: "owner", joinedAt: "2026-01-01T00:00:00.000Z" }]);
});

describe("invitation response routes", () => {
  it("accepts using the server-confirmed email, never the session email claim", async () => {
    const req = invitationRequest();
    const response = await accept(req, {} as never);
    expect(response.status).toBe(200);
    expect(mocks.requireConfirmedAccountEmail).toHaveBeenCalledWith(req, user);
    expect(accounts.acceptInvitation).toHaveBeenCalledExactlyOnceWith(hashInvitationToken(rawToken), USER_ID, "verified@example.test");
  });

  it("rejects using the server-confirmed email, never the session email claim", async () => {
    const req = invitationRequest();
    const response = await reject(req, {} as never);
    expect(response.status).toBe(200);
    expect(mocks.requireConfirmedAccountEmail).toHaveBeenCalledWith(req, user);
    expect(accounts.rejectInvitation).toHaveBeenCalledExactlyOnceWith(hashInvitationToken(rawToken), USER_ID, "verified@example.test");
  });

  it("does not mutate invitation state if the verified-email check fails", async () => {
    mocks.requireConfirmedAccountEmail.mockRejectedValue(new Error("unverified"));
    await expect(accept(invitationRequest(), {} as never)).rejects.toThrow("unverified");
    await expect(reject(invitationRequest(), {} as never)).rejects.toThrow("unverified");
    expect(accounts.acceptInvitation).not.toHaveBeenCalled();
    expect(accounts.rejectInvitation).not.toHaveBeenCalled();
  });

  it("loads members for all current organizations with one repository call", async () => {
    const req = new NextRequest("https://siteinsight.example/api/organizations?includeMembers=true");
    const response = await listOrganizations(req, {} as never);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.listOrganizations).toHaveBeenCalledExactlyOnceWith(USER_ID);
    expect(mocks.listMembersForUserOrganizations).toHaveBeenCalledExactlyOnceWith(USER_ID);
    expect(body.data.members).toHaveLength(1);
    expect(body.data.members[0].organizationId).toBe("org-1");
  });

  it("accepts and declines inbox invitations by ID using the verified session email", async () => {
    const invitationId = "22222222-3333-4444-8555-666666666666";
    const req = new NextRequest(`https://siteinsight.example/api/organizations/invitations/${invitationId}/accept`, { method: "POST" });
    const context = { params: Promise.resolve({ invitationId }) };
    const accepted = await acceptById(req, context as never);
    const declined = await rejectById(req, context as never);
    expect(accepted.status).toBe(200);
    expect(declined.status).toBe(200);
    expect(accounts.acceptInvitationById).toHaveBeenCalledExactlyOnceWith(invitationId, USER_ID, "verified@example.test");
    expect(accounts.rejectInvitationById).toHaveBeenCalledExactlyOnceWith(invitationId, USER_ID, "verified@example.test");
  });

  it("lists recipient invitations only after resolving the confirmed account email", async () => {
    const req = new NextRequest("https://siteinsight.example/api/organizations/invitations");
    const response = await listRecipientInvitations(req, {} as never);
    expect(response.status).toBe(200);
    expect(mocks.requireConfirmedAccountEmail).toHaveBeenCalledWith(req, user);
    expect(accounts.listRecipientInvitations).toHaveBeenCalledExactlyOnceWith("verified@example.test");
  });

  it("maps expired, replayed, and full-team results without changing the authenticated email boundary", async () => {
    const invitationId = "22222222-3333-4444-8555-666666666666";
    const req = new NextRequest(`https://siteinsight.example/api/organizations/invitations/${invitationId}/accept`, { method: "POST" });
    const context = { params: Promise.resolve({ invitationId }) };
    mocks.acceptInvitationById.mockResolvedValueOnce("expired");
    await expect(acceptById(req, context as never)).rejects.toMatchObject({ status: 410, code: "invitation_expired" });
    mocks.acceptInvitationById.mockResolvedValueOnce("not_pending");
    await expect(acceptById(req, context as never)).rejects.toMatchObject({ status: 409, code: "invitation_not_pending" });
    mocks.acceptInvitationById.mockResolvedValueOnce("member_limit");
    await expect(acceptById(req, context as never)).rejects.toMatchObject({ status: 409, code: "member_limit" });
    expect(mocks.requireConfirmedAccountEmail).toHaveBeenCalledTimes(3);
    expect(accounts.acceptInvitationById).toHaveBeenNthCalledWith(1, invitationId, USER_ID, "verified@example.test");
  });

  it("passes only the confirmed email to the repository, which rejects invite mismatches", async () => {
    const invitationId = "22222222-3333-4444-8555-666666666666";
    mocks.acceptInvitationById.mockResolvedValue("email_mismatch");
    const req = new NextRequest(`https://siteinsight.example/api/organizations/invitations/${invitationId}/accept`, { method: "POST" });
    await expect(acceptById(req, { params: Promise.resolve({ invitationId }) } as never)).rejects.toMatchObject({ status: 403, code: "invitation_email_mismatch" });
    expect(accounts.acceptInvitationById).toHaveBeenCalledExactlyOnceWith(invitationId, USER_ID, "verified@example.test");
  });

  it("keeps the ordinary organization list response light unless members are requested", async () => {
    const response = await listOrganizations(new NextRequest("https://siteinsight.example/api/organizations"), {} as never);
    expect(response.status).toBe(200);
    expect(mocks.listMembersForUserOrganizations).not.toHaveBeenCalled();
  });
});
