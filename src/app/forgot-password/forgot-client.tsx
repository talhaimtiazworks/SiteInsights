"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthCard, Field } from "@/components/auth-ui";
import { Alert, Button, Input, Spinner } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";

export function ForgotPasswordClient() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setFieldError("Enter a valid email address.");
    setFieldError(null);
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/forgot-password", { method: "POST", json: { email } });
      setSent(true);
    } catch (err) {
      setError((err as ApiClientError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard busyLabel={busy ? "Preparing your password reset…" : undefined} title="Reset your password" description="We'll email you a link to choose a new password." footer={<Link href="/sign-in" className="font-medium text-primary hover:underline">Back to sign in</Link>}>
      {sent ? (
        <Alert tone="success" title="Check your email">
          If an account exists for <strong>{email}</strong>, check your inbox and spam folder for a password reset link. Delivery may take a few minutes. If no link arrives, try again later.
        </Alert>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Field label="Email" htmlFor="email" error={fieldError}>
            <Input id="email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!fieldError || undefined} aria-describedby={fieldError ? "email-error" : undefined} />
          </Field>
          <Button type="submit" className="w-full" disabled={busy} aria-busy={busy}>
            {busy ? <Spinner /> : null}
            {busy ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
