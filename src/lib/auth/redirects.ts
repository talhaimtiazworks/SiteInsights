export const NEW_ACCOUNT_ONBOARDING_PATH = "/account/professional-profile";
/** Same-browser recipient continuation after authentication from a team-invitation link. */
export const INVITATION_CONTINUATION_PATH = "/teams/invitation";

/**
 * Post-auth redirect targets are restricted to paths on this site, so a link
 * like /sign-in?next=https://evil.example cannot send users elsewhere.
 */
export function safeNext(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw) return fallback;
  let v = raw.trim();
  // Accept absolute URLs only to extract their path; the origin is always discarded.
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      v = u.pathname + u.search + u.hash;
    } catch {
      return fallback;
    }
  }
  if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\") || /[\u0000-\u001f]/.test(v)) return fallback;
  // Never bounce back into auth endpoints.
  if (/^\/(api\/auth|auth\/callback)/.test(v)) return fallback;
  return v.slice(0, 512);
}

/** Email templates pass {{ .RedirectTo }} (…/auth/callback?next=…); use its inner same-site path. */
export function unwrapNext(raw: string | undefined): string {
  if (!raw) return safeNext(null);
  try {
    const u = new URL(raw, "http://placeholder.invalid");
    if (u.pathname === "/auth/callback") return safeNext(u.searchParams.get("next"));
  } catch {
    return safeNext(null);
  }
  return safeNext(raw);
}

