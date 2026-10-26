import type { Metadata } from "next";
import { IssueClient } from "./issue-client";

export const metadata: Metadata = { title: "Issue details", robots: { index: false } };

export default async function IssuePage({ params }: { params: Promise<{ id: string; findingId: string }> }) {
  const { id, findingId } = await params;
  return <IssueClient scanId={id} findingId={findingId} />;
}
