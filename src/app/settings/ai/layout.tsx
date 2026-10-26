import { requirePageSession } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  await requirePageSession("/settings/ai");
  return children;
}
