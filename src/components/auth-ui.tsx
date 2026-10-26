"use client";

import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { api, ApiClientError } from "@/lib/client/api";
import type { AuthProvidersInfo } from "@/lib/client/types";
import { Button, Input, Spinner, cn } from "./ui";
import { LogoMark } from "./brand";
import { BRAND } from "@/lib/brand";

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>
      {children}
      {error ? <p id={`${htmlFor}-error`} className="text-sm text-danger">{error}</p> : hint ? <p id={`${htmlFor}-hint`} className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function PasswordInput({ id, invalid, ...props }: ComponentProps<"input"> & { id: string; invalid?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input id={id} type={show ? "text" : "password"} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-error` : `${id}-hint`} className="pr-16" {...props} />
      <button type="button" onClick={() => setShow((s) => !s)} className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-muted-foreground hover:text-foreground" aria-label={show ? "Hide password" : "Show password"} aria-pressed={show}>
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}

const GoogleIcon = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
    <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.8z" />
    <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
    <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1z" />
    <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
  </svg>
);
const GitHubIcon = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
    <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.6 18.3 5 18.3 5c.7 1.7.3 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z" />
  </svg>
);

export const PROVIDER_META = {
  google: { label: "Google", Icon: GoogleIcon },
  github: { label: "GitHub", Icon: GitHubIcon },
} as const;

/** Starts OAuth on the server and navigates to the provider. Only enabled providers are rendered. */
export function OAuthButtons({ providers, next, onError, verb = "Continue", mode = "sign_in" }: { providers: AuthProvidersInfo; next: string; onError: (msg: string) => void; verb?: string; mode?: "sign_in" | "sign_up" }) {
  const [busy, setBusy] = useState<"google" | "github" | null>(null);
  const list = (["google", "github"] as const).filter((p) => providers[p]);
  if (!list.length) return null;
  const go = async (provider: "google" | "github") => {
    if (busy) return;
    setBusy(provider);
    try {
      const { url } = await api<{ url: string }>("/api/auth/oauth", { method: "POST", json: { provider, next, mode } });
      window.location.assign(url);
    } catch (e) {
      onError(e instanceof ApiClientError ? e.message : "Could not start sign-in. Please try again.");
      setBusy(null);
    }
  };
  return (
    <div className="grid gap-2">
      {busy ? <p role="status" aria-live="polite" className="sr-only">Connecting securely with {PROVIDER_META[busy].label}…</p> : null}
      {list.map((p) => {
        const { label, Icon } = PROVIDER_META[p];
        return (
          <Button key={p} type="button" variant="outline" className="w-full" onClick={() => go(p)} disabled={busy !== null} aria-busy={busy === p}>
            {busy === p ? <Spinner /> : <Icon />}
            {busy === p ? `Connecting to ${label}…` : `${verb} with ${label}`}
          </Button>
        );
      })}
    </div>
  );
}

export function Divider({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      {children}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export function AuthCard({ title, description, children, footer, className, busyLabel }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string; busyLabel?: string }) {
  const id = useId();
  return (
    <div className={cn("container flex justify-center py-10 sm:py-16", className)}>
      <section aria-labelledby={id} className="w-full max-w-md">
        <div className="rounded-2xl border bg-card p-6 shadow-soft sm:p-8">
          <div className="mb-6 flex items-center gap-4"><LogoMark title={BRAND.logoAlt} className="h-20 w-20" /><div><p className="text-sm font-bold">{BRAND.name}</p><p className="mt-0.5 text-xs text-muted-foreground">by {BRAND.parent}</p></div></div>
          <h1 id={id} className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-1.5 text-sm text-muted-foreground">{description}</p> : null}
          <div className="mt-6 space-y-5" aria-busy={!!busyLabel}>{children}{busyLabel ? <p role="status" aria-live="polite" className="sr-only">{busyLabel}</p> : null}</div>
        </div>
        {footer ? <div className="mt-4 text-center text-sm text-muted-foreground">{footer}</div> : null}
        <p className="mt-5 text-center text-xs text-muted-foreground">{BRAND.attribution}</p>
      </section>
    </div>
  );
}

/** Client-side password rules (the server and Supabase validate again). */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return "Use at least 8 characters.";
  if (pw.length > 72) return "Use at most 72 characters.";
  return null;
}

export function strength(pw: string): { score: 0 | 1 | 2 | 3; label: string } {
  let s = 0;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  if (pw.length < 8) return { score: 0, label: "Too short" };
  return { score: s as 0 | 1 | 2 | 3, label: ["Weak", "Fair", "Good", "Strong"][s] };
}
