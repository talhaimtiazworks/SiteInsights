"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthCard, Divider, Field, OAuthButtons, PasswordInput, passwordProblem, strength } from "@/components/auth-ui";
import { Alert, Button, Input, Spinner, cn } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import type { AuthProvidersInfo } from "@/lib/client/types";

export function SignUpClient({ providers, next, signInNext = next }: { providers: AuthProvidersInfo; next: string; signInNext?: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState<"idle" | "sending" | "sent">("idle");
  const [fe, setFe] = useState<Record<string, string>>({});
  const q = signInNext !== "/dashboard" ? `?next=${encodeURIComponent(signInNext)}` : "";

  if (providers.signupDisabled) {
    return (
      <AuthCard title="Sign-ups are closed" footer={<>Already have an account? <Link className="font-medium text-primary hover:underline" href={`/sign-in${q}`}>Sign in</Link></>}>
        <Alert tone="info">New accounts can&apos;t be created on this deployment right now.</Alert>
      </AuthCard>
    );
  }

  if (sentTo) {
    return (
      <AuthCard title="Check your email" description={<>If this address is eligible, check <strong className="text-foreground">{sentTo}</strong> for a confirmation link.</>}>
        <p className="text-sm text-muted-foreground">Open the link in that email to activate your account, then you&apos;ll be signed in. The link expires after a while — if it does, request a new one.</p>
        <p className="text-sm text-muted-foreground">Didn&apos;t get it? Check your spam folder.</p>
        {resent === "sent" ? (
          <Alert tone="success">Request received. If this address is eligible for confirmation, check your inbox and spam folder.</Alert>
        ) : (
          <Button
            variant="outline"
            className="w-full"
            disabled={resent === "sending"}
            onClick={async () => {
              setResent("sending");
              try {
                await api("/api/auth/resend", { method: "POST", json: { email: sentTo, next } });
                setResent("sent");
              } catch (err) {
                setMessage((err as ApiClientError).message);
                setResent("idle");
              }
            }}
          >
            {resent === "sending" ? <Spinner /> : null}
            Resend confirmation email
          </Button>
        )}
        {message ? <Alert tone="error">{message}</Alert> : null}
        <p className="text-center text-sm"><Link href={`/sign-in${q}`} className="font-medium text-primary hover:underline">Back to sign in</Link></p>
      </AuthCard>
    );
  }

  const st = strength(password);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs: Record<string, string> = {};
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) errs.email = "Enter a valid email address.";
    const p = passwordProblem(password);
    if (p) errs.password = p;
    if (!p && confirm !== password) errs.confirm = "Passwords don't match.";
    if (!agree) errs.agree = "Please accept the terms to continue.";
    setFe(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ status: "signed_in" | "confirmation_required"; next?: string; email?: string }>("/api/auth/sign-up", { method: "POST", json: { email, password, displayName: name || undefined, next } });
      if (r.status === "signed_in") window.location.assign(r.next ?? next);
      else {
        setSentTo(r.email ?? email);
        setBusy(false);
      }
    } catch (err) {
      setMessage((err as ApiClientError).message);
      setBusy(false);
    }
  };

  return (
    <AuthCard
      busyLabel={busy ? "Creating your account…" : undefined}
      title="Create your account"
      description="Free plan included. Save audits, track fixes and compare results over time."
      footer={<>Already have an account? <Link href={`/sign-in${q}`} className="font-medium text-primary hover:underline">Sign in</Link></>}
    >
      {message ? <Alert tone="error">{message}</Alert> : null}
      <OAuthButtons providers={providers} next={signInNext} onError={setMessage} verb="Sign up" mode="sign_up" />
      {(providers.google || providers.github) && providers.email ? <Divider>or</Divider> : null}
      {providers.email ? (
        <form onSubmit={submit} noValidate className="space-y-4">
          <Field label="Name (optional)" htmlFor="name">
            <Input id="name" autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email" htmlFor="email" error={fe.email}>
            <Input id="email" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!fe.email || undefined} aria-describedby={fe.email ? "email-error" : undefined} />
          </Field>
          <Field label="Password" htmlFor="password" error={fe.password} hint="At least 8 characters. Longer is stronger.">
            <PasswordInput id="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} invalid={!!fe.password} />
          </Field>
          {password ? (
            <div aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
              <div className="flex flex-1 gap-1" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <span key={i} className={cn("h-1.5 flex-1 rounded-full", i < st.score ? (st.score >= 3 ? "bg-success" : st.score === 2 ? "bg-brand-amber" : "bg-danger") : "bg-muted")} />
                ))}
              </div>
              <span>Strength: {st.label}</span>
            </div>
          ) : null}
          <Field label="Confirm password" htmlFor="confirm" error={fe.confirm}>
            <PasswordInput id="confirm" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} invalid={!!fe.confirm} />
          </Field>
          <div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={agree} onChange={(e) => setAgree(e.target.checked)} aria-invalid={!!fe.agree || undefined} />
              <span>I agree to the <Link href="/terms" className="font-medium text-primary hover:underline">Terms</Link> and <Link href="/privacy" className="font-medium text-primary hover:underline">Privacy Policy</Link>.</span>
            </label>
            {fe.agree ? <p className="mt-1 text-sm text-danger">{fe.agree}</p> : null}
          </div>
          <Button type="submit" className="w-full" disabled={busy} aria-busy={busy}>
            {busy ? <Spinner /> : null}
            {busy ? "Creating account…" : "Create account"}
          </Button>
        </form>
      ) : null}
    </AuthCard>
  );
}
