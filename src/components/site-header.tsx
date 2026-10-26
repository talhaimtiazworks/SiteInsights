"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
import { BRAND } from "@/lib/brand";
import { useSession } from "@/lib/client/session";
import { AccountMenu } from "./account-menu";
import { LogoMark, Wordmark } from "./brand";
import { buttonClass, cn } from "./ui";

type NavItem = { href: string; label: string; exact?: boolean };

/**
 * Shared navigation model. GUIDE_NAV_ITEM is an internal route (/guide) — the
 * free client-acquisition guide.
 */
export const GUIDE_NAV_ITEM: NavItem = { href: "/guide", label: "Guide" };

/** Main navigation. Login vs Dashboard follows the verified server session. */
export function navItems(signedIn: boolean | null): NavItem[] {
  const items: NavItem[] = [
    { href: "/", label: "Home", exact: true },
    { href: "/features", label: "Features" },
    GUIDE_NAV_ITEM,
  ];
  if (signedIn === true) items.push({ href: "/dashboard", label: "Dashboard" });
  items.push(
    { href: "/teams", label: "Teams" },
    { href: "/contact", label: "Contact" },
    { href: "/help", label: "Docs" },
  );
  if (signedIn === false) items.push({ href: "/sign-in", label: "Log in" });
  return items;
}

export function SiteHeader() {
  const pathname = usePathname();
  // The mobile menu belongs to the path it was opened on, so navigation closes it without an effect.
  const [openPath, setOpenPath] = useState<string | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const { session } = useSession();
  const signedIn = session ? !!session.user : null;
  const NAV = navItems(signedIn);
  const open = openPath === pathname;
  const setOpen = (value: boolean) => setOpenPath(value ? pathname : null);
  const isActive = (n: NavItem) => (n.exact ? pathname === n.href : pathname === n.href || pathname.startsWith(n.href + "/"));
  const cta = signedIn ? { href: "/audit/new", label: "Start audit" } : { href: "/sign-up?next=%2Faudit%2Fnew", label: "Start free audit" };

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-charcoal/95 text-white shadow-lg shadow-charcoal/10 backdrop-blur-xl print:hidden">
      <div className="container flex h-16 items-center justify-between gap-3 lg:gap-4">
        <Link href="/" className="inline-flex min-w-0 shrink-0 items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-charcoal">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white p-1.5 shadow-sm">
            <LogoMark className="h-full w-full" />
          </span>
          <span className="flex min-w-0 flex-col">
            <Wordmark className="text-base leading-5 text-white sm:text-[1.0625rem]" />
            <span className="mt-0.5 whitespace-nowrap text-[9px] font-medium leading-3 tracking-wide text-white/65">by {BRAND.parent}</span>
          </span>
          <span className="sr-only"> home</span>
        </Link>

        <nav className="hidden h-full min-w-0 items-center gap-0.5 lg:flex" aria-label="Main">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                "relative inline-flex h-full items-center rounded-lg px-2 text-[13px] font-medium transition-colors xl:px-2.5",
                isActive(n)
                  ? "text-white after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-gold"
                  : "text-white/70 hover:bg-white/5 hover:text-white",
              )}
              aria-current={isActive(n) ? "page" : undefined}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <Link href={cta.href} className={buttonClass("secondary", "sm", "hidden sm:inline-flex shadow-soft")}>
            {cta.label}
          </Link>
          {signedIn ? <AccountMenu onNavigate={() => setOpen(false)} /> : null}
          <button
            ref={menuButton}
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-white/85 transition-colors hover:bg-white/10 hover:text-white lg:hidden"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen(!open)}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              {open ? <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" /> : <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />}
            </svg>
          </button>
        </div>
      </div>
      <nav
        id="mobile-nav"
        hidden={!open}
        className="border-t border-white/10 bg-charcoal lg:hidden"
        aria-label="Mobile"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            menuButton.current?.focus();
          }
        }}
      >
          <div className="container grid gap-1 py-3 sm:grid-cols-2">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => { setOpen(false); menuButton.current?.focus(); }}
                aria-current={isActive(n) ? "page" : undefined}
                className={cn(
                  "block min-h-11 rounded-xl px-4 py-2.5 text-base font-medium transition-colors",
                  isActive(n) ? "bg-white/10 text-white ring-1 ring-white/10" : "text-white/75 hover:bg-white/5 hover:text-white",
                )}
              >
                {n.label}
              </Link>
            ))}
            <Link href={cta.href} onClick={() => { setOpen(false); menuButton.current?.focus(); }} className={buttonClass("secondary", "md", "mt-2 sm:col-span-2")}>
              {cta.label}
            </Link>
          </div>
      </nav>
    </header>
  );
}
