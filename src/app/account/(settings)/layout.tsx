import { AccountsDisabled } from "@/components/accounts-disabled";
import { AccountNav } from "@/components/account-nav";
import { isAdminUser } from "@/lib/admin/allowlist";
import { requirePageSession } from "@/lib/auth/page-guard";

// The session check must run on every request (never prerendered at build time).
export const dynamic = "force-dynamic";

/** All account pages require a signed-in user, validated on the server. */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const s = await requirePageSession("/account/profile");
  if (!s.accounts) return <AccountsDisabled />;
  return (
    <div className="container py-8 sm:py-10">
      <div className="grid gap-6 md:grid-cols-[13rem_1fr] md:gap-10">
        {/* The flag comes from the server-verified session email — never from
            client input or an editable profile field. */}
        <AccountNav isAdmin={isAdminUser(s.user)} />
        <div className="min-w-0 max-w-3xl">{children}</div>
      </div>
    </div>
  );
}
