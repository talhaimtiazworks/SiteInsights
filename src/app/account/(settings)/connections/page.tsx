import type { Metadata } from "next";
import { ConnectionsClient } from "./connections-client";

export const metadata: Metadata = { title: "Connected accounts" };

export default function ConnectionsPage() {
  return <ConnectionsClient />;
}
