import type { Metadata } from "next";
import { Suspense } from "react";
import { ListPageSkeleton } from "@/components/skeletons";
import { AuditsClient } from "./audits-client";

export const metadata: Metadata = { title: "Audits" };

export default function AuditsPage() {
  return (
    <Suspense fallback={<ListPageSkeleton label="Loading audits" />}>
      <AuditsClient />
    </Suspense>
  );
}
