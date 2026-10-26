import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authPreflight: vi.fn(),
  requireAccount: vi.fn(),
  getAuthState: vi.fn(),
  maybeAccountRepository: vi.fn(),
}));

vi.mock("@/lib/auth/route-helpers", () => ({ authPreflight: mocks.authPreflight }));
vi.mock("@/lib/services/account", () => ({ requireAccount: mocks.requireAccount }));
vi.mock("@/lib/auth/server", () => ({ getAuthState: mocks.getAuthState }));
vi.mock("@/lib/db", () => ({ maybeAccountRepository: mocks.maybeAccountRepository }));

import { PATCH } from "@/app/api/account/profile/route";
import { GET as getSession } from "@/app/api/auth/session/route";

const USER_ID = "11111111-2222-4333-8444-555555555555";
const GITHUB_AVATAR = "https://avatars.githubusercontent.com/u/583231?v=4";
const LEGACY_AVATAR = "https://untrusted.example/old-profile-photo.png";

let accounts: {
  updateProfile: ReturnType<typeof vi.fn>;
  getUserSettings: ReturnType<typeof vi.fn>;
  getProfile: ReturnType<typeof vi.fn>;
};

function profileRequest(body: unknown) {
  return new NextRequest("https://siteinsight.example/api/account/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  accounts = {
    updateProfile: vi.fn(),
    getUserSettings: vi.fn().mockResolvedValue({ theme: "system", defaultBrowser: true, defaultPerformance: true, updatedAt: null }),
    getProfile: vi.fn().mockResolvedValue({ avatarUrl: LEGACY_AVATAR }),
  };
  mocks.authPreflight.mockImplementation(() => undefined);
  mocks.requireAccount.mockResolvedValue({
    user: {
      id: USER_ID,
      email: "person@example.test",
      displayName: "Current name",
      providers: ["github"],
      isSso: false,
      sessionMethod: "github",
      avatarUrl: GITHUB_AVATAR,
    },
    accounts,
    profile: { id: USER_ID },
  });
  mocks.getAuthState.mockResolvedValue({
    status: "signed_in",
    user: {
      id: USER_ID,
      email: "person@example.test",
      displayName: "Current name",
      providers: ["github"],
      isSso: false,
      sessionMethod: "github",
      avatarUrl: GITHUB_AVATAR,
    },
  });
  mocks.maybeAccountRepository.mockReturnValue(accounts);
});

afterEach(() => vi.clearAllMocks());

describe("profile API avatar boundary", () => {
  it("rejects client-supplied avatar URLs and never updates the profile", async () => {
    const response = await PATCH(profileRequest({ displayName: "Name", avatarUrl: "https://attacker.example/image.png" }), {});
    expect(response.status).toBe(400);
    expect(accounts.updateProfile).not.toHaveBeenCalled();
  });

  it("returns the validated session avatar rather than a legacy stored URL", async () => {
    accounts.updateProfile.mockResolvedValue({
      id: USER_ID,
      email: "person@example.test",
      displayName: "New name",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      avatarUrl: LEGACY_AVATAR,
    });
    const response = await PATCH(profileRequest({ displayName: "New name" }), {});
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(accounts.updateProfile).toHaveBeenCalledExactlyOnceWith(USER_ID, { displayName: "New name" });
    expect(body.data.profile.avatarUrl).toBe(GITHUB_AVATAR);
  });

  it("session endpoint uses only the server-validated avatar, not the persisted profile field", async () => {
    const response = await getSession(new NextRequest("https://siteinsight.example/api/auth/session"), {});
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.user.avatarUrl).toBe(GITHUB_AVATAR);
    expect(accounts.getProfile).not.toHaveBeenCalled();
  });
});
