import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isAdminUser } from "@/lib/admin/allowlist";
import { getPageSession } from "@/lib/auth/page-guard";
import { AdminAnalyticsClient } from "./analytics-client";
import { AnalyticsErrorBoundary } from "./error-boundary";

export const dynamic = "force-dynamic";
// Unadvertised route: no bespoke title (the 404 shown to non-owners must look
// generic), never indexed.
export const metadata: Metadata = {
  robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
};

/**
 * Private owner dashboard. Access is enforced in three independent layers:
 *  1. this server page returns 404 for anyone outside the owner allowlist;
 *  2. every /api/admin/analytics/* endpoint re-checks the allowlist;
 *  3. the analytics tables are unreachable through the public Data API (RLS).
 * Hiding the URL is not the security — the allowlist is.
 */
export default async function AdminAnalyticsPage() {
  const session = await getPageSession();
  if (!session.user || !isAdminUser(session.user)) notFound();
  return (
    <AnalyticsErrorBoundary>
      <AdminAnalyticsClient />
    </AnalyticsErrorBoundary>
  );
}
