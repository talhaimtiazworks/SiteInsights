/**
 * Public pages do not need an auth refresh before rendering. They never expose
 * account data; the client session endpoint validates/refreshes once after
 * hydration. That endpoint also validates itself, so proxy must not repeat it.
 * All other routes retain the existing proxy refresh plus their own server-side
 * authorization checks.
 */
const ROUTES_THAT_VALIDATE_AFTER_RENDER = new Set([
  "/",
  "/about",
  "/features",
  "/guide",
  "/contact",
  "/help",
  "/privacy",
  "/terms",
  "/usage",
  "/audit/new",
  "/api/auth/session",
]);

export function proxyShouldRefreshSession(pathname: string): boolean {
  return !ROUTES_THAT_VALIDATE_AFTER_RENDER.has(pathname);
}
