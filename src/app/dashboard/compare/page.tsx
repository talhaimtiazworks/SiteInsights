import type { Metadata } from "next";
import { Suspense } from "react";
import { ListPageSkeleton } from "@/components/skeletons";
import { CompareClient } from "./compare-client";

export const metadata: Metadata = { title: "Compare audits" };

export default function ComparePage() {
  return (
    <Suspense fallback={<ListPageSkeleton label="Loading comparison" />}>
      <CompareClient />
    </Suspense>
  );
}
