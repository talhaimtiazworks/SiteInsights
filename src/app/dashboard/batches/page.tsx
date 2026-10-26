import type { Metadata } from "next";
import { BatchesClient } from "./batches-client";

export const metadata: Metadata = { title: "Batch audits" };

export default function BatchesPage() {
  return <BatchesClient />;
}
