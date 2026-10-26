import { describe, expect, it } from "vitest";
import { authLinkErrorTarget } from "@/lib/client/auth-link-error";
import { AUTH_ERROR_MESSAGES } from "@/lib/client/auth-messages";

const q = (target: string | null) => Object.fromEntries(new URL(target!, "https://x.invalid").searchParams);

describe("authLinkErrorTarget (Supabase fragment errors → branded sign-in message)", () => {
  it("maps an expired / already-used email link", () => {
    const t = authLinkErrorTarget("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired", "");
    expect(t?.startsWith("/sign-in?")).toBe(true);
    expect(q(t)).toEqual({ error: "otp_expired" });
  });

  it("maps legacy access_denied + 'expired' description to otp_expired, plain access_denied stays 'cancelled'", () => {
    expect(q(authLinkErrorTarget("#error=access_denied&error_description=Token+has+expired+or+is+invalid", "")).error).toBe("otp_expired");
    expect(q(authLinkErrorTarget("#error=access_denied&error_description=User+denied", "")).error).toBe("access_denied");
  });

  it("unknown codes become a generic message; nothing from the fragment is reflected", () => {
    const t = authLinkErrorTarget("#error=<script>alert(1)</script>&error_description=<b>pwn</b>", "");
    expect(q(t)).toEqual({ error: "callback_failed" });
    expect(t).not.toMatch(/script|pwn/);
  });

  it("ignores fragments that are not auth errors", () => {
    expect(authLinkErrorTarget("", "")).toBeNull();
    expect(authLinkErrorTarget("#features", "")).toBeNull();
    expect(authLinkErrorTarget("#access_token=abc&type=recovery", "")).toBeNull();
    expect(authLinkErrorTarget("#terror=1", "")).toBeNull();
  });

  it("keeps a same-site next path and drops open-redirect attempts", () => {
    expect(q(authLinkErrorTarget("#error_code=otp_expired", "?next=/dashboard/audits")).next).toBe("/dashboard/audits");
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example/x", "javascript:alert(1)", "/api/auth/oauth"]) {
      const next = q(authLinkErrorTarget("#error_code=otp_expired", `?next=${encodeURIComponent(bad)}`)).next;
      expect(next === undefined || (next.startsWith("/") && !next.startsWith("//") && !next.includes("evil")), bad).toBe(true);
    }
  });

  it("every code it can produce has a user-facing message", () => {
    for (const code of ["otp_expired", "access_denied", "flow_state_expired", "bad_code_verifier", "provider_disabled", "signup_disabled", "email_not_confirmed", "identity_already_exists", "server_error", "callback_failed"]) {
      expect(AUTH_ERROR_MESSAGES[code], code).toBeTruthy();
    }
  });
});
