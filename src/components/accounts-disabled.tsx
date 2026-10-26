import { Alert, ButtonLink } from "./ui";
import { LogoMark } from "./brand";
import { BRAND } from "@/lib/brand";

/** Missing configuration is fail-closed: it must never become an anonymous-audit mode. */
export function AccountsDisabled({ title = "Sign-in is being set up" }: { title?: string }) {
  return (
    <div className="container max-w-xl py-12 sm:py-20">
      <div className="mb-6 flex items-center gap-4"><LogoMark title={BRAND.logoAlt} className="h-20 w-20" /><div><p className="font-semibold">{BRAND.name}</p><p className="text-sm text-muted-foreground">by {BRAND.parent}</p></div></div>
      <Alert tone="info" title={title}>A verified account is required to run audits and open reports. Sign-in is not configured on this deployment yet, so no audit can be started. Please contact the deployment administrator or try again later.</Alert>
      <p className="mt-4 text-sm text-muted-foreground">Administrators: configure the existing Supabase project URL and publishable key, then redeploy. See the Supabase setup guide included with this project. Never put service-role credentials in the browser.</p>
      <div className="mt-6 flex flex-wrap gap-3"><ButtonLink href="/">Back to home</ButtonLink><ButtonLink href="/help" variant="outline">Explore the checks</ButtonLink></div>
    </div>
  );
}
