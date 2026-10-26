import type { Metadata } from "next";
import { OrganizationsClient } from "./organizations-client";

export const metadata: Metadata = { title: "Teams" };

export default function OrganizationsPage() {
  return <OrganizationsClient />;
}
