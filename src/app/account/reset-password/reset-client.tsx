"use client";

import { useState } from "react";
import { AuthCard, Field, PasswordInput, passwordProblem } from "@/components/auth-ui";
import { Alert, Button, ButtonLink, Spinner } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";

export function ResetPasswordClient({ email, next }: { email: string | null; next: string }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  if (done) {
    return (
      <AuthCard title="Password updated" description="You're signed in with your new password.">
        <ButtonLink href={next} className="w-full">{next.startsWith("/account/organizations") ? "Continue to team invitation" : "Go to dashboard"}</ButtonLink>
      </AuthCard>
    );
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs: Record<string, string> = {};
    const p = passwordProblem(pw);
    if (p) errs.pw = p;
    else if (pw !== confirm) errs.confirm = "Passwords don't match.";
    setFe(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/update-password", { method: "POST", json: { password: pw } });
      setDone(true);
    } catch (err) {
      const e2 = err as ApiClientError;
      setError(e2.code === "current_password_required" ? "This reset link has already been used or expired. Request a new one, or change your password under Account → Security." : e2.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard busyLabel={busy ? "Updating your password…" : undefined} title="Choose a new password" description={email ? `For ${email}` : undefined}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="New password" htmlFor="pw" error={fe.pw} hint="At least 8 characters.">
          <PasswordInput id="pw" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} invalid={!!fe.pw} autoFocus />
        </Field>
        <Field label="Confirm new password" htmlFor="confirm" error={fe.confirm}>
          <PasswordInput id="confirm" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} invalid={!!fe.confirm} />
        </Field>
        <Button type="submit" className="w-full" disabled={busy} aria-busy={busy}>{busy ? <Spinner /> : null}{busy ? "Updating…" : "Update password"}</Button>
      </form>
    </AuthCard>
  );
}
