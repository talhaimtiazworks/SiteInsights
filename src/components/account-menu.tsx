"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { signOut, useSession } from "@/lib/client/session";
import { buttonClass, cn } from "./ui";
import { isTrustedGithubAvatarUrl } from "@/lib/avatar";

export function initials(name: string | null | undefined, email: string | null | undefined) {
  const src = (name || email || "?").trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (name && parts[1] ? parts[1][0] : "")).toUpperCase();
}

export function Avatar({ name, email, url, className }: { name: string | null; email: string | null; url?: string | null; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const source = isTrustedGithubAvatarUrl(url) ? url : null;
  if (source && failedUrl !== source) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={source} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(source)} className={cn("h-8 w-8 rounded-full object-cover", className)} />;
  }
  return <span aria-hidden="true" className={cn("inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary", className)}>{initials(name, email)}</span>;
}

/** Header account control: sign-in link, or the signed-in user's menu. */
export function AccountMenu({ onNavigate }: { onNavigate?: () => void }) {
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!session) return null;
  if (!session.user) {
    return (
      <Link href="/sign-in" onClick={onNavigate} className={buttonClass("ghost", "sm", "hidden sm:inline-flex")}>
        Sign in
      </Link>
    );
  }
  const u = session.user;
  const item = "block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted";
  return (
    <div ref={ref} className="relative">
      <button type="button" className="inline-flex h-10 items-center gap-2 rounded-xl pl-1 pr-1 text-white/85 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-offset-charcoal sm:pr-2" aria-haspopup="menu" aria-expanded={open} aria-label={`Account menu, ${initials(u.displayName, u.email)}`} onClick={() => setOpen((o) => !o)}>
        <Avatar name={u.displayName} email={u.email} url={u.avatarUrl} />
        <svg viewBox="0 0 20 20" className="hidden h-4 w-4 text-white/65 sm:block" fill="currentColor" aria-hidden="true"><path d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4z" /></svg>
      </button>
      {open ? (
        <div role="menu" aria-label="Account" className="absolute right-0 z-50 mt-2 w-64 rounded-lg border bg-card p-1.5 text-[#1B1931] shadow-lg">
          <div className="border-b px-3 pb-2 pt-1.5">
            <p className="truncate text-sm font-medium">{u.displayName || "Your account"}</p>
            <p className="truncate text-xs text-muted-foreground">{u.email}</p>
          </div>
          <div className="py-1">
            {[
              ["/dashboard", "Dashboard"],
              ["/dashboard/audits", "My audits"],
              ["/dashboard/prospects", "Prospects"],
              ["/teams", "Teams"],
              ["/billing", "Account & history"],
              ["/account/usage", "Usage"],
              ["/account/profile", "Account settings"],
              ["/feedback", "Share feedback"],
            ].map(([href, label]) => (
              <Link key={href} role="menuitem" href={href} className={item} onClick={() => { setOpen(false); onNavigate?.(); }}>
                {label}
              </Link>
            ))}
          </div>
          <div className="border-t pt-1">
            <button
              type="button"
              role="menuitem"
              className={item}
              disabled={signingOut}
              onClick={async () => {
                setSigningOut(true);
                const done = await signOut("/");
                if (!done) setSigningOut(false);
              }}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
