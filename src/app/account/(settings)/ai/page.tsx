import type { Metadata } from "next";
import { AiSettingsClient } from "@/app/settings/ai/ai-settings-client";

export const metadata: Metadata = { title: "AI settings" };

export default function AccountAiPage() {
  return <AiSettingsClient embedded />;
}
