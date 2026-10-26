import type { Metadata } from "next";
import { Suspense } from "react";
import { SettingsSkeleton } from "@/components/skeletons";
import { BillingClient } from "./billing-client";

export const metadata: Metadata = { title: "Account & history", robots: { index: false, follow: false } };

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="container max-w-4xl py-10"><SettingsSkeleton label="Loading billing" /></div>}>
      <BillingClient />
    </Suspense>
  );
}
