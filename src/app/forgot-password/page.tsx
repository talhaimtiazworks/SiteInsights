import type { Metadata } from "next";
import { AccountsDisabled } from "@/components/accounts-disabled";
import { authEnabled } from "@/lib/auth/server";
import { ForgotPasswordClient } from "./forgot-client";

export const metadata: Metadata = { title: "Reset your password", robots: { index: false } };
export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  if (!authEnabled()) return <AccountsDisabled />;
  return <ForgotPasswordClient />;
}
