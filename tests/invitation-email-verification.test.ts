import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/http/api";
import type { AuthUser } from "@/lib/auth/server";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), supabaseForRequest: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ requireUser: vi.fn(), supabaseForRequest: mocks.supabaseForRequest }));

import { requireConfirmedAccountEmail } from "@/lib/services/account";

const req = {} as NextRequest;
const user = { id: "11111111-2222-4333-8444-555555555555", email: "old-claim@example.test" } as AuthUser;
const confirmed = { id: user.id, email: " Team.Member@Example.test ", email_confirmed_at: "2026-01-01T00:00:00.000Z" };

beforeEach(() => {
  mocks.getUser.mockReset();
  mocks.supabaseForRequest.mockReset();
  mocks.supabaseForRequest.mockReturnValue({ auth: { getUser: mocks.getUser } });
});

describe("confirmed invitation email", () => {
  it("uses the current normalized email returned by Supabase Auth for the matching account", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: confirmed }, error: null });
    await expect(requireConfirmedAccountEmail(req, user)).resolves.toBe("team.member@example.test");
    expect(mocks.supabaseForRequest).toHaveBeenCalledWith(req);
  });

  it("rejects an email that has no server-side confirmation timestamp", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { ...confirmed, email_confirmed_at: null } }, error: null });
    await expect(requireConfirmedAccountEmail(req, user)).rejects.toMatchObject({ status: 403, code: "email_unverified" });
  });

  it("rejects a missing email or a user that differs from the validated session", async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: { ...confirmed, email: null } }, error: null });
    await expect(requireConfirmedAccountEmail(req, user)).rejects.toMatchObject({ status: 403, code: "email_unverified" });
    mocks.getUser.mockResolvedValueOnce({ data: { user: { ...confirmed, id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } }, error: null });
    await expect(requireConfirmedAccountEmail(req, user)).rejects.toMatchObject({ status: 401, code: "session_expired" });
  });

  it("fails closed on Auth errors and outages without echoing claim data", async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: { status: 503 } });
    await expect(requireConfirmedAccountEmail(req, user)).rejects.toMatchObject({ status: 503, code: "auth_unavailable" });
    mocks.getUser.mockRejectedValueOnce(new Error("network failure"));
    const unavailable = requireConfirmedAccountEmail(req, user);
    await expect(unavailable).rejects.toBeInstanceOf(ApiError);
    await expect(unavailable).rejects.toMatchObject({ status: 503, code: "auth_unavailable" });
  });
});
