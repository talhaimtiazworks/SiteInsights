import type { Metadata } from "next";
import { ProgressClient } from "./progress-client";

export const metadata: Metadata = { title: "Scan progress", robots: { index: false } };

export default async function ProgressPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProgressClient id={id} />;
}
