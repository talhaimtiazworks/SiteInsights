import { describe, expect, it } from "vitest";
import { proxyShouldRefreshSession } from "@/lib/auth/session-refresh";

describe("deferred public-page session refresh", () => {
  it("defers refresh for public shell routes whose own content needs no user data", () => {
    for (const path of ["/", "/about", "/features", "/guide", "/contact", "/help", "/privacy", "/terms", "/usage", "/audit/new", "/api/auth/session"]) {
      expect(proxyShouldRefreshSession(path), path).toBe(false);
    }
  });

  it("keeps session refresh on protected and auth-flow routes", () => {
    for (const path of ["/dashboard", "/account/professional-profile", "/api/scans", "/api/credits", "/sign-in", "/sign-up", "/auth/callback"]) {
      expect(proxyShouldRefreshSession(path), path).toBe(true);
    }
  });
});
