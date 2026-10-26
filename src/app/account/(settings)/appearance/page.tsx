import type { Metadata } from "next";
import { AppearanceClient } from "./appearance-client";

export const metadata: Metadata = { title: "Audit defaults" };

export default function AppearancePage() {
  return <AppearanceClient />;
}
