import { describe, expect, it } from "vitest";
import { userFromClaims } from "@/lib/auth/server";

const GITHUB_AVATAR = "https://avatars.githubusercontent.com/u/583231?v=4";
const GOOGLE_AVATAR = "https://lh3.googleusercontent.com/a/test";

function claims({
  provider,
  method,
  avatarUrl = GITHUB_AVATAR,
  picture = GOOGLE_AVATAR,
}: {
  provider: string;
  method: string;
  avatarUrl?: string | null;
  picture?: string | null;
}) {
  return {
    sub: "11111111-2222-4333-8444-555555555555",
    session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    email: "person@example.test",
    app_metadata: { provider, providers: [provider] },
    amr: [{ method, provider }],
    user_metadata: { avatar_url: avatarUrl, picture },
  };
}

const githubMarker = { provider: "github" as const, avatarUrl: GITHUB_AVATAR };
const googleMarker = { provider: "google" as const, avatarUrl: null };

describe("provider avatars derived from the validated current-session marker", () => {
  it("uses the trusted GitHub avatar when the signed current-session marker says GitHub", () => {
    const user = userFromClaims(claims({ provider: "github", method: "oauth" }), githubMarker);
    expect(user.sessionMethod).toBe("github");
    expect(user.avatarUrl).toBe(GITHUB_AVATAR);
    expect(user.providers).toEqual(["github"]);
  });

  it("uses the default for a Google session even when GitHub is the linked or first app-metadata provider", () => {
    const googleClaims = {
      ...claims({ provider: "github", method: "oauth" }),
      app_metadata: { provider: "github", providers: ["github", "google"] },
    };
    const user = userFromClaims(googleClaims, googleMarker);
    expect(user.sessionMethod).toBe("github"); // existing claim semantics remain intact
    expect(user.avatarUrl).toBeNull();
  });

  it("does not use avatar metadata for password, SSO, or other non-GitHub sessions", () => {
    const password = userFromClaims(claims({ provider: "email", method: "password" }), githubMarker);
    expect(password.sessionMethod).toBe("password");
    expect(password.avatarUrl).toBeNull();

    const githubPassword = userFromClaims(claims({ provider: "github", method: "password" }), githubMarker);
    expect(githubPassword.sessionMethod).toBe("password");
    expect(githubPassword.avatarUrl).toBeNull();

    const sso = userFromClaims({
      ...claims({ provider: "sso:customer", method: "sso/saml" }),
      app_metadata: { provider: "sso:customer", providers: [] },
    }, githubMarker);
    expect(sso.isSso).toBe(true);
    expect(sso.avatarUrl).toBeNull();

    expect(userFromClaims(claims({ provider: "google", method: "oauth" }), googleMarker).avatarUrl).toBeNull();
  });

  it("ignores user-editable metadata and falls back for missing or invalid signed marker data", () => {
    expect(userFromClaims(claims({ provider: "github", method: "oauth" })).avatarUrl).toBeNull();
    expect(userFromClaims(claims({ provider: "github", method: "oauth", avatarUrl: null, picture: GITHUB_AVATAR })).avatarUrl).toBeNull();
    expect(userFromClaims(claims({ provider: "github", method: "oauth" }), { provider: "github", avatarUrl: null }).avatarUrl).toBeNull();
    expect(userFromClaims(claims({ provider: "github", method: "oauth" }), { provider: "github", avatarUrl: "https://evil.example/avatar.png" }).avatarUrl).toBeNull();
    expect(userFromClaims(claims({ provider: "github", method: "oauth" }), { provider: "google", avatarUrl: GITHUB_AVATAR }).avatarUrl).toBeNull();
  });
});
