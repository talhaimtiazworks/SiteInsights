import { requirePageSession } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

/** Billing shows account data only; the session is validated on the server. */
export default async function BillingLayout({ children }: { children: React.ReactNode }) {
  await requirePageSession("/billing");
  return children;
}
