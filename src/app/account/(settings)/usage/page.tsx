import type { Metadata } from "next";
import { UsageClient } from "@/app/usage/usage-client";

export const metadata: Metadata = { title: "Usage" };

export default function AccountUsagePage() {
  return <UsageClient embedded />;
}
