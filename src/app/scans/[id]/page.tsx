import type { Metadata } from "next";
import { ResultsClient } from "./results-client";

export const metadata: Metadata = { title: "Audit report", robots: { index: false } };

export default async function ResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ResultsClient id={id} />;
}
