import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AccountsDisabled } from "@/components/accounts-disabled";
import { getPageSession } from "@/lib/auth/page-guard";
import { getAuthProviders } from "@/lib/auth/providers";
import { INVITATION_CONTINUATION_PATH, NEW_ACCOUNT_ONBOARDING_PATH, safeNext } from "@/lib/auth/redirects";
import { SignUpClient } from "./sign-up-client";

export const metadata: Metadata = { title: "Create an account", robots: { index: false } };
export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function SignUpPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const requestedNext = safeNext(Array.isArray(sp.next) ? sp.next[0] : sp.next);
  const session = await getPageSession();
  if (!session.accounts) return <AccountsDisabled />;
  // Existing signed-in users keep their requested destination; only a new
  // registration flow is routed through the professional-profile onboarding.
  if (session.user) redirect(requestedNext);
  // Standard new registrations retain the existing professional-profile setup.
  // A recipient who is creating an account from a team invite returns to that
  // pending invitation first so optional profile fields never block consent.
  const registrationNext = requestedNext === INVITATION_CONTINUATION_PATH ? requestedNext : NEW_ACCOUNT_ONBOARDING_PATH;
  return <SignUpClient providers={await getAuthProviders()} next={registrationNext} signInNext={requestedNext} />;
}
