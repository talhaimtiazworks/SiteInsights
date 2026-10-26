"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "./ui";

const ITEMS = [
  ["/account/profile", "Profile"],
  ["/account/professional-profile", "Professional profile"],
  ["/account/security", "Security"],
  ["/account/connections", "Connected accounts"],
  ["/account/ai", "AI settings"],
  ["/account/usage", "Usage"],
  ["/account/appearance", "Audit defaults"],
  ["/account/organizations", "Teams"],
  ["/account/delete", "Delete account"],
] as const;

export function AccountNav({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Account settings" className="min-w-0">
      <p className="mb-2 hidden text-xs font-semibold uppercase tracking-wide text-muted-foreground md:block">Account</p>
      <ul className="-mx-1 flex gap-1 overflow-x-auto pb-1 md:mx-0 md:flex-col md:overflow-visible">
        {/* Admin Analytics is rendered only when the server-verified session
            belongs to the allowlisted owner. Hiding is not security: the
            /admin/analytics page and every /api/admin/* route enforce the
            same allowlist server-side. */}
        {isAdmin ? (
          <li className="shrink-0">
            <Link
              href="/admin/analytics"
              aria-current={pathname === "/admin/analytics" ? "page" : undefined}
              className={cn(
                "block whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium",
                pathname === "/admin/analytics" ? "nav-selected" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              Admin Analytics
            </Link>
          </li>
        ) : null}
        {ITEMS.map(([href, label]) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <li key={href} className="shrink-0">
              <Link href={href} aria-current={active ? "page" : undefined} className={cn("block whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium", active ? "nav-selected" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground", href === "/account/delete" && !active && "text-danger")}>
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
