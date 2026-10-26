import type { Metadata } from "next";
import { AiSettingsClient } from "./ai-settings-client";

export const metadata: Metadata = { title: "AI settings" };

export default function AiSettingsPage() {
  return <AiSettingsClient />;
}
