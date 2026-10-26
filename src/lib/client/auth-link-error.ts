import { safeNext } from "@/lib/auth/redirects";

/**
 * Supabase reports failed email/OAuth links (expired, already used, denied) in
 * the URL *fragment*, e.g. `/#error=access_denied&error_code=otp_expired&…`,
 * which never reaches the server. This maps such a fragment to the sign-in
 * page's branded message. Only known codes are passed through; nothing from the
 * fragment is rendered, and `next` goes through the same open-redirect guard as
 * every other post-auth redirect.
 */
const KNOWN = new Set(["otp_expired", "access_denied", "flow_state_expired", "bad_code_verifier", "provider_disabled", "signup_disabled", "email_not_confirmed", "identity_already_exists", "server_error"]);

/** Returns the same-origin path to navigate to, or null when the fragment isn't an auth error. */
export function authLinkErrorTarget(hash: string, search: string): string | null {
  if (!hash || !/(^#|&)(error_code|error)=/.test(hash)) return null;
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const raw = p.get("error_code") || p.get("error") || "";
  let code = KNOWN.has(raw) ? raw : "callback_failed";
  // Older GoTrue versions send only error=access_denied with an "expired/invalid" description for dead email links.
  if (code === "access_denied" && /expired|invalid/i.test(p.get("error_description") ?? "")) code = "otp_expired";
  const q = new URLSearchParams({ error: code });
  const nextRaw = new URLSearchParams(search.replace(/^\?/, "")).get("next");
  if (nextRaw) {
    const next = safeNext(nextRaw, "");
    if (next) q.set("next", next);
  }
  return `/sign-in?${q.toString()}`;
}
