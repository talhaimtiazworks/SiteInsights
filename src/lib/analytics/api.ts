import type { AnalyticsOverview, PopularPageRow, RecentActivityRow } from "../db/analytics-types";
import { unwrapApi } from "./api-envelope";

/** Client-side fetch helpers for the owner dashboard. One module so the
 * request construction (and its tests) live outside the React tree. */

export interface PageBundle {
  readonly rows: PopularPageRow[];
  readonly total: number;
}
export interface ActivityBundle {
  readonly rows: RecentActivityRow[];
  readonly total: number;
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, credentials: "same-origin" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return unwrapApi<T>(await res.json(), res.status);
}

/** Overview + both page tables in ONE parallel batch (no waterfall). */
export async function fetchDashboardCore(query: string, signal: AbortSignal): Promise<{
  overview: AnalyticsOverview;
  popular: PageBundle;
  landings: PageBundle;
}> {
  const [overview, popular, landings] = await Promise.all([
    fetchJson<AnalyticsOverview>(`/api/admin/analytics/overview?${query}`, signal),
    fetchJson<PageBundle>(`/api/admin/analytics/popular?${query}&limit=10`, signal),
    fetchJson<PageBundle>(`/api/admin/analytics/landings?${query}&limit=10`, signal),
  ]);
  return { overview, popular, landings };
}

/** Activity feed is fetched independently so pagination never reloads charts. */
export function fetchActivityPage(query: string, page: number, perPage: number, signal: AbortSignal): Promise<ActivityBundle> {
  return fetchJson<ActivityBundle>(`/api/admin/analytics/activity?${query}&limit=${perPage}&offset=${page * perPage}`, signal);
}
