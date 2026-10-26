import type { Metadata } from "next";
import { Suspense } from "react";
import { ListPageSkeleton } from "@/components/skeletons";
import { ProspectsClient } from "./prospects-client";

export const metadata: Metadata = { title: "Prospects" };

export default function ProspectsPage() {
  return (
    <Suspense fallback={<ListPageSkeleton label="Loading prospects" />}>
      <ProspectsClient />
    </Suspense>
  );
}
