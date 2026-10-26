import type { Metadata } from "next";
import { AccountsDisabled } from "@/components/accounts-disabled";
import { authEnabled } from "@/lib/auth/server";
import { ConfirmClient } from "./confirm-client";

export const metadata: Metadata = { title: "Confirm", robots: { index: false } };
export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const TYPES = ["email", "signup", "recovery", "email_change", "invite", "magiclink"] as const;

/**
 * Landing page for links in Supabase emails (templates in supabase/templates).
 * Verification only happens when the person clicks the button, so link
 * scanners that pre-open emails can't use up the one-time token.
 */
export default async function ConfirmPage({ searchParams }: { searchParams: SP }) {
  if (!authEnabled()) return <AccountsDisabled />;
  const sp = await searchParams;
  const type = one(sp.type) as (typeof TYPES)[number];
  const tokenHash = one(sp.token_hash);
  return <ConfirmClient tokenHash={/^[A-Za-z0-9_-]{10,200}$/.test(tokenHash) ? tokenHash : null} type={TYPES.includes(type) ? type : null} next={one(sp.next)} />;
}
