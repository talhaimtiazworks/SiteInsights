import { describe, expect, it } from "vitest";
import {
  createOAuthProviderState,
  createSessionProviderMarker,
  latestOAuthIdentityProvider,
  readSessionProviderMarker,
  verifyOAuthProviderState,
} from "@/lib/auth/session-provider";

const SECRET = "test-session-signing-secret-with-at-least-32-bytes";
const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const GITHUB_AVATAR = "https://avatars.githubusercontent.com/u/583231?v=4";

// Fixed clock makes expiry boundaries deterministic.
const NOW = Date.parse("2026-10-21T12:00:00.000Z");

describe("OAuth provider provenance", () => {
  it("signs a short-lived OAuth-start provider and rejects mismatched, forged, and expired state", () => {
    const state = createOAuthProviderState("github", SECRET, "sign_in", NOW);
    expect(state).toBeTruthy();
    expect(verifyOAuthProviderState(state, SECRET, NOW)).toMatchObject({ provider: "github", mode: "sign_in", issuedAt: Math.floor(NOW / 1000) });
    expect(verifyOAuthProviderState(state, "wrong-signing-secret-with-more-than-32-bytes", NOW)).toBeNull();
    expect(verifyOAuthProviderState(`${state}x`, SECRET, NOW)).toBeNull();
    expect(verifyOAuthProviderState(state, SECRET, NOW + 11 * 60 * 1000)).toBeNull();
    expect(verifyOAuthProviderState(createOAuthProviderState("google", null, "sign_in", NOW), SECRET, NOW)).toBeNull();
    expect(createOAuthProviderState("github", "short", "sign_in", NOW)).toBeNull();

    const signupState = createOAuthProviderState("google", SECRET, "sign_up", NOW);
    expect(verifyOAuthProviderState(signupState, SECRET, NOW)).toMatchObject({ provider: "google", mode: "sign_up", issuedAt: Math.floor(NOW / 1000) });

    const linkState = createOAuthProviderState("github", SECRET, "link", NOW);
    expect(verifyOAuthProviderState(linkState, SECRET, NOW)).toMatchObject({ provider: "github", mode: "link", issuedAt: Math.floor(NOW / 1000) });
  });

  it("binds a session provider and trusted GitHub avatar to one validated session id", () => {
    const marker = createSessionProviderMarker("github", SESSION_ID, GITHUB_AVATAR, SECRET);
    expect(marker).toBeTruthy();
    expect(readSessionProviderMarker(marker, SESSION_ID, SECRET)).toEqual({ provider: "github", avatarUrl: GITHUB_AVATAR });
    expect(readSessionProviderMarker(marker, "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", SECRET)).toBeNull();
    expect(readSessionProviderMarker(marker, SESSION_ID, "another-signing-secret-with-more-than-32-bytes")).toBeNull();

    const tampered = marker!.replace("github", "google");
    expect(readSessionProviderMarker(tampered, SESSION_ID, SECRET)).toBeNull();
  });

  it("records non-GitHub providers without an avatar and rejects untrusted avatar candidates", () => {
    const google = createSessionProviderMarker("google", SESSION_ID, "https://lh3.googleusercontent.com/photo", SECRET);
    expect(readSessionProviderMarker(google, SESSION_ID, SECRET)).toEqual({ provider: "google", avatarUrl: null });

    const untrusted = createSessionProviderMarker("github", SESSION_ID, "https://evil.example/avatar.png", SECRET);
    expect(readSessionProviderMarker(untrusted, SESSION_ID, SECRET)).toEqual({ provider: "github", avatarUrl: null });
  });

  it("recognizes only a unique most-recent Google or GitHub identity", () => {
    expect(latestOAuthIdentityProvider([
      { provider: "github", last_sign_in_at: "2026-10-20T10:00:00.000Z" },
      { provider: "google", last_sign_in_at: "2026-10-21T10:00:00.000Z" },
    ])).toBe("google");
    expect(latestOAuthIdentityProvider([
      { provider: "github", last_sign_in_at: "2026-10-21T10:00:00.000Z" },
      { provider: "google", last_sign_in_at: "2026-10-20T10:00:00.000Z" },
    ])).toBe("github");
    expect(latestOAuthIdentityProvider([
      { provider: "github", last_sign_in_at: "2026-10-21T10:00:00.000Z" },
      { provider: "google", last_sign_in_at: "2026-10-21T10:00:00.000Z" },
    ])).toBeNull();
    expect(latestOAuthIdentityProvider([{ provider: "github" }])).toBeNull();
    expect(latestOAuthIdentityProvider(null)).toBeNull();
  });
});
