import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isTrustedGithubAvatarUrl, trustedProviderAvatarUrl } from "@/lib/avatar";
import { MIGRATIONS } from "@/lib/db/migrations";

const ROOT = path.resolve(__dirname, "..");
const GITHUB_AVATAR = "https://avatars.githubusercontent.com/u/583231?v=4";

function source(relativePath: string) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("GitHub provider avatar URL policy", () => {
  it("accepts the HTTPS GitHub user-avatar endpoint only for the GitHub provider", () => {
    expect(trustedProviderAvatarUrl("github", GITHUB_AVATAR)).toBe(GITHUB_AVATAR);
    expect(trustedProviderAvatarUrl("GitHub", GITHUB_AVATAR)).toBe(GITHUB_AVATAR);
    expect(trustedProviderAvatarUrl("google", GITHUB_AVATAR)).toBeNull();
    expect(trustedProviderAvatarUrl("email", GITHUB_AVATAR)).toBeNull();
    expect(trustedProviderAvatarUrl("sso:customer", GITHUB_AVATAR)).toBeNull();
  });

  it.each([
    "http://avatars.githubusercontent.com/u/583231?v=4",
    "https://github.com/u/583231?v=4",
    "https://avatars.githubusercontent.com.evil.example/u/583231?v=4",
    "https://avatars.githubusercontent.com@evil.example/u/583231?v=4",
    "https://avatars.githubusercontent.com:443/u/583231?v=4",
    "https://avatars.githubusercontent.com/u/583231?v=4#fragment",
    "https://avatars.githubusercontent.com/repo/583231.png",
    "https://avatars.githubusercontent.com/u/583231?token=secret",
    "javascript:alert(1)",
    "//avatars.githubusercontent.com/u/583231?v=4",
    "",
  ])("rejects an untrusted or malformed avatar URL: %s", (candidate) => {
    expect(trustedProviderAvatarUrl("github", candidate)).toBeNull();
    expect(isTrustedGithubAvatarUrl(candidate)).toBe(false);
  });

  it("rejects non-string and oversized metadata", () => {
    expect(trustedProviderAvatarUrl("github", null)).toBeNull();
    expect(trustedProviderAvatarUrl("github", 123)).toBeNull();
    expect(trustedProviderAvatarUrl("github", `${GITHUB_AVATAR}${"x".repeat(2048)}`)).toBeNull();
  });
});

describe("profile/avatar UI and legacy migration safety", () => {
  it("uses the shared trusted-avatar component and contains no manual upload path", () => {
    const menu = source("src/components/account-menu.tsx");
    const profile = source("src/app/account/(settings)/profile/profile-client.tsx");
    expect(menu).toContain("isTrustedGithubAvatarUrl");
    expect(menu).toContain("onError={() => setFailedUrl(source)}");
    expect(profile).toContain("url={p.avatarUrl}");
    expect(profile).not.toMatch(/type=["']file["']/i);
    expect(profile).not.toMatch(/uploadAvatarToSignedUrl|createObjectURL|\/api\/account\/avatar/);
    expect(existsSync(path.join(ROOT, "src/app/api/account/avatar/route.ts"))).toBe(false);
    expect(existsSync(path.join(ROOT, "src/lib/client/avatar-upload.ts"))).toBe(false);
    expect(existsSync(path.join(ROOT, "src/lib/avatar-storage.ts"))).toBe(false);
    expect(existsSync(path.join(ROOT, "scripts/migrate-avatar-objects-to-b2.mjs"))).toBe(false);
    const repository = source("src/lib/db/postgres.ts");
    expect(repository).not.toMatch(/avatar_url|avatarUrl/);
  });

  it("preserves migration 007 outside the generated/automatic migration set", () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    const legacyMigration = source("db/optional/007_avatar_storage.sql");
    expect(versions).toContain("006_plans_credits_prospects");
    expect(versions).not.toContain("007_avatar_storage");
    expect(source("db/supabase-setup.sql")).not.toContain("007_avatar_storage");
    expect(legacyMigration).toContain("CREATE POLICY sitelens_avatars_directory_guard");
  });
});
