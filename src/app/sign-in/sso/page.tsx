import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AccountsDisabled } from "@/components/accounts-disabled";
import { getPageSession } from "@/lib/auth/page-guard";
import { getAuthProviders } from "@/lib/auth/providers";
import { safeNext } from "@/lib/auth/redirects";
import { SsoClient } from "./sso-client";

export const metadata: Metadata = { title: "Single sign-on", robots: { index: false } };
export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function SsoPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const next = safeNext(Array.isArray(sp.next) ? sp.next[0] : sp.next);
  const session = await getPageSession();
  if (!session.accounts) return <AccountsDisabled />;
  if (session.user) redirect(next);
  const providers = await getAuthProviders();
  return <SsoClient enabled={providers.saml} next={next} />;
}
