import "server-only";
import { ApiError } from "../http/api";
import type { AnalyticsRange } from "../db/analytics-types";

const MAX_DAYS = 366;

/**
 * Parses the bounded date range shared by every admin analytics endpoint.
 * Presets: 7 | 30 | 90 days. Custom: ?from=&to= (inclusive, UTC, capped).
 */
export function parseAnalyticsRange(url: URL): AnalyticsRange {
  const sp = url.searchParams;
  const now = new Date();
  const daysParam = sp.get("days");
  const fromParam = sp.get("from");
  const toParam = sp.get("to");

  if (fromParam || toParam) {
    const from = fromParam ? new Date(fromParam) : null;
    const to = toParam ? new Date(toParam) : null;
    if (!from || !to || !isFinite(from.getTime()) || !isFinite(to.getTime())) {
      throw new ApiError(400, "invalid_range", "The from/to parameters must be valid ISO dates.");
    }
    if (from > to) throw new ApiError(400, "invalid_range", "The from date must not be after the to date.");
    if (to.getTime() - from.getTime() > MAX_DAYS * 86_400_000) {
      throw new ApiError(400, "invalid_range", `The date range is limited to ${MAX_DAYS} days.`);
    }
    return { from, to, bucket: bucketFor(from, to) };
  }

  const days = daysParam === null ? 30 : Number(daysParam);
  if (![7, 30, 90].includes(days)) {
    throw new ApiError(400, "invalid_range", "The days parameter must be one of 7, 30, 90 (or pass explicit from/to).");
  }
  const from = new Date(now.getTime() - days * 86_400_000);
  return { from, to: now, bucket: bucketFor(from, now) };
}

function bucketFor(from: Date, to: Date): AnalyticsRange["bucket"] {
  return to.getTime() - from.getTime() <= 48 * 3_600_000 ? "hour" : "day";
}

/** Bounded pagination (limit ≤ 50, offset < 10 000) shared by table endpoints. */
export function parsePagination(url: URL): { limit: number; offset: number } {
  const limitRaw = Number(url.searchParams.get("limit") ?? "10");
  const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 50 ? limitRaw : 10;
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 && offsetRaw < 10_000 ? offsetRaw : 0;
  return { limit, offset };
}
