import "server-only";
import { ApiError } from "../http/api";

/**
 * Maps unexpected persistence failures in the owner-analytics read path to a
 * deliberate, logged 503 instead of an opaque 500. The dashboard renders its
 * "temporarily unavailable" state with automatic retry on the normal poll
 * schedule. The log line records the endpoint and the database error code /
 * sanitized message only — never env values, credentials or table data.
 */
export function analyticsFailure(endpoint: string, err: unknown): never {
  // Operational errors raised by the app itself (validation 400s, throttling,
  // authz) must keep their original status — only unexpected failures map to
  // the logged 503.
  if (err instanceof ApiError) throw err;
  const pg = err as { code?: unknown; message?: unknown } | null;
  const code = typeof pg?.code === "string" ? pg.code : "unknown";
  const message = typeof pg?.message === "string" ? pg.message.replace(/\s+/g, " ").slice(0, 300) : String(err).slice(0, 300);
  console.error(`[analytics] ${endpoint}_failed`, JSON.stringify({ code, message }));
  if (code === "42P01") {
    // relation does not exist — migration 011_analytics has not been applied
    throw new ApiError(503, "analytics_not_migrated", "Analytics storage has not been migrated on this deployment yet. Run `npm run db:migrate`.");
  }
  throw new ApiError(503, "analytics_unavailable", "Analytics are temporarily unavailable. Please try again shortly.");
}
