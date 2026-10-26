"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthCard, Divider, Field, OAuthButtons, PasswordInput } from "@/components/auth-ui";
import { Alert, Button, Input, Spinner } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { authErrorMessage } from "@/lib/client/auth-messages";
import type { AuthProvidersInfo } from "@/lib/client/types";

export function SignInClient({ providers, next, error, reason }: { providers: AuthProvidersInfo; next: string; error: string | null; reason: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(authErrorMessage(error));
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [resent, setResent] = useState<"idle" | "sending" | "sent">("idle");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const q = next !== "/dashboard" ? `?next=${encodeURIComponent(next)}` : "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const fe: typeof fieldErrors = {};
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) fe.email = "Enter a valid email address.";
    if (!password) fe.password = "Enter your password.";
    setFieldErrors(fe);
    if (Object.keys(fe).length) return;
    setBusy(true);
    setMessage(null);
    setUnconfirmed(false);
    try {
      const r = await api<{ next: string }>("/api/auth/sign-in", { method: "POST", json: { email, password, next } });
      // Full navigation so every component re-reads the new session.
      window.location.assign(r.next);
    } catch (err) {
      const e2 = err as ApiClientError;
      setMessage(e2.message);
      setUnconfirmed(e2.code === "email_not_confirmed");
      setBusy(false);
    }
  };

  const resend = async () => {
    setResent("sending");
    try {
      await api("/api/auth/resend", { method: "POST", json: { email, next } });
      setResent("sent");
    } catch (err) {
      setMessage((err as ApiClientError).message);
      setResent("idle");
    }
  };

  return (
    <AuthCard
      busyLabel={busy ? "Signing you in securely…" : undefined}
      title="Sign in to SiteInsights"
      description="Your audits, reports and settings are saved to your account."
      footer={
        providers.signupDisabled ? null : (
          <>
            New to SiteInsights? <Link href={`/sign-up${q}`} className="font-medium text-primary hover:underline">Create an account</Link>
          </>
        )
      }
    >
      {next.startsWith("/audit") ? <Alert tone="info">Sign in before starting an audit. After sign-in, review the website and submit it explicitly—nothing runs automatically.</Alert> : null}
      {reason === "expired" && !message ? <Alert tone="warning">Your session has expired. Please sign in again.</Alert> : null}
      {reason === "global_signout_incomplete" && !message ? <Alert tone="warning">You&apos;re signed out on this device, but we couldn&apos;t confirm that your other sessions were ended. Sign in and choose &quot;Sign out everywhere&quot; again in Account → Security.</Alert> : null}
      {message ? (
        <Alert tone="error">
          {message}
          {unconfirmed ? (
            <span className="mt-2 block">
              {resent === "sent" ? (
                "Request received. If this address has an unconfirmed account, check your inbox and spam folder."
              ) : (
                <button type="button" className="font-medium underline" onClick={resend} disabled={resent === "sending"}>
                  {resent === "sending" ? "Sending…" : "Resend confirmation email"}
                </button>
              )}
            </span>
          ) : null}
        </Alert>
      ) : null}
      {providers.unavailable ? <Alert tone="warning">Some sign-in options couldn&apos;t be loaded. Email sign-in may still work.</Alert> : null}

      <OAuthButtons providers={providers} next={next} onError={setMessage} />
      {(providers.google || providers.github) && providers.email ? <Divider>or</Divider> : null}

      {providers.email ? (
        <form onSubmit={submit} noValidate className="space-y-4">
          <Field label="Email" htmlFor="email" error={fieldErrors.email}>
            <Input id="email" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!fieldErrors.email || undefined} aria-describedby={fieldErrors.email ? "email-error" : undefined} />
          </Field>
          <Field label="Password" htmlFor="password" error={fieldErrors.password}>
            <PasswordInput id="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} invalid={!!fieldErrors.password} />
          </Field>
          <div className="flex justify-end text-sm">
            <Link href="/forgot-password" className="font-medium text-primary hover:underline">Forgot password?</Link>
          </div>
          <Button type="submit" className="w-full" disabled={busy} aria-busy={busy}>
            {busy ? <Spinner /> : null}
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      ) : null}

      {providers.saml ? (
        <p className="text-center text-sm">
          <Link href={`/sign-in/sso${q}`} className="font-medium text-primary hover:underline">Sign in with single sign-on (SSO)</Link>
        </p>
      ) : null}
    </AuthCard>
  );
}
