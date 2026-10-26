import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/client/api", () => ({ api: mocks.api }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useSyncExternalStore: ((_: unknown, getSnapshot: () => unknown) => getSnapshot()) as typeof actual.useSyncExternalStore };
});

import { invalidateSession, refreshSession, useSession } from "@/lib/client/session";
import type { SessionInfo } from "@/lib/client/types";

const anonymous: SessionInfo = { status: "anonymous", accountsEnabled: true, theme: null, settings: null, user: null };
const signedIn: SessionInfo = { status: "signed_in", accountsEnabled: true, theme: null, settings: null, user: { id: "user-1", email: "person@example.test", displayName: null, avatarUrl: null, isSso: false } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-22T00:00:00.000Z"));
  mocks.api.mockReset();
  invalidateSession();
});
afterEach(() => vi.useRealTimers());

describe("client session request coalescing", () => {
  it("shares the in-flight request and caches a server-validated result for 30 seconds", async () => {
    mocks.api.mockResolvedValue(anonymous);
    const a = refreshSession();
    const b = refreshSession();
    expect(mocks.api).toHaveBeenCalledTimes(1);
    await expect(a).resolves.toEqual(anonymous);
    await expect(b).resolves.toEqual(anonymous);
    await expect(refreshSession()).resolves.toEqual(anonymous);
    expect(mocks.api).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_001);
    await expect(refreshSession()).resolves.toEqual(anonymous);
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });

  it("lets a required revalidation bypass the cache and fails closed on an outage", async () => {
    mocks.api.mockResolvedValueOnce(signedIn).mockRejectedValueOnce(new Error("offline"));
    await expect(refreshSession()).resolves.toEqual(signedIn);
    expect(useSession().session).toEqual(signedIn);
    await expect(refreshSession(true)).resolves.toBeNull();
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(useSession()).toMatchObject({ session: null, loading: false, error: "We couldn't verify your session. Check your connection and try again." });
    // Failed validation isn't reused as authenticated state; a retry makes a new request.
    mocks.api.mockResolvedValueOnce(anonymous);
    await expect(refreshSession()).resolves.toEqual(anonymous);
    expect(mocks.api).toHaveBeenCalledTimes(3);
  });
});
