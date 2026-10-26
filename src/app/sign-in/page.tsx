import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AccountsDisabled } from "@/components/accounts-disabled";
import { getPageSession } from "@/lib/auth/page-guard";
import { getAuthProviders } from "@/lib/auth/providers";
import { safeNext } from "@/lib/auth/redirects";
import { SignInClient } from "./sign-in-client";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };
export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

export default async function SignInPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const next = safeNext(one(sp.next));
  const session = await getPageSession();
  if (!session.accounts) return <AccountsDisabled />;
  if (session.user) redirect(next);
  const providers = await getAuthProviders();
  return <SignInClient providers={providers} next={next} error={one(sp.error)} reason={one(sp.reason)} />;
}
