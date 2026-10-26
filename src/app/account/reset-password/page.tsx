import type { Metadata } from "next";
import { AccountsDisabled } from "@/components/accounts-disabled";
import { requirePageSession } from "@/lib/auth/page-guard";
import { safeNext } from "@/lib/auth/redirects";
import { ResetPasswordClient } from "./reset-client";

export const metadata: Metadata = { title: "Choose a new password", robots: { index: false } };
export const dynamic = "force-dynamic";

/** Reached from the password-reset email (a short-lived recovery session). */
type SP = Promise<Record<string, string | string[] | undefined>>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

export default async function ResetPasswordPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const next = safeNext(first(sp.next), "/dashboard");
  const s = await requirePageSession("/account/reset-password");
  if (!s.accounts) return <AccountsDisabled />;
  return <ResetPasswordClient email={s.user?.email ?? null} next={next} />;
}
