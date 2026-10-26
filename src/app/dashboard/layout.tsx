import { requirePageSession } from "@/lib/auth/page-guard";

// The session check must run on every request (never prerendered at build time).
export const dynamic = "force-dynamic";

/** Dashboard pages need a signed-in user when accounts are enabled (validated on the server). */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await requirePageSession("/dashboard");
  return children;
}
