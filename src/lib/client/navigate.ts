"use client";

/**
 * Full page navigation. Used deliberately when the auth state changes (sign-in,
 * sign-out, expired session, account deletion) so every component — including
 * the header and server-rendered layouts — re-reads the session.
 */
export function hardNavigate(path: string) {
  window.location.assign(path);
}

/** Sends the user to sign in, returning to the current page afterwards. */
export function toSignIn(reason?: "expired") {
  const here = window.location.pathname + window.location.search;
  hardNavigate(`/sign-in?next=${encodeURIComponent(here)}${reason ? `&reason=${reason}` : ""}`);
}
