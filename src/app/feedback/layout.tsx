import { requirePageSession } from "@/lib/auth/page-guard";

// Feedback is account-based: submission is tied to the signed-in account,
// exactly like the dashboard. Session check runs on every request.
export const dynamic = "force-dynamic";

export default async function FeedbackLayout({ children }: { children: React.ReactNode }) {
  await requirePageSession("/feedback");
  return children;
}
