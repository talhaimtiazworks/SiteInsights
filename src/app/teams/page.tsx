import type { Metadata } from "next";
import { OrganizationsClient } from "@/app/account/(settings)/organizations/organizations-client";
import { requirePageSession } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Teams" };

/** Reuses the existing organization, invitation, membership and audit-sharing system. */
export default async function TeamsPage() {
  await requirePageSession("/teams");
  return <OrganizationsClient standalone />;
}
