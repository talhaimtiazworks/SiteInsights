"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthCard } from "@/components/auth-ui";
import { Alert, Button, Spinner } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";

const COPY: Record<string, { title: string; body: string; button: string }> = {
  signup: { title: "Confirm your email", body: "Confirm your email address to activate your SiteInsights account.", button: "Confirm email" },
  email: { title: "Confirm your email", body: "Confirm your email address to continue.", button: "Confirm email" },
  recovery: { title: "Reset your password", body: "Continue to choose a new password for your account.", button: "Continue" },
  email_change: { title: "Confirm email change", body: "Confirm that you want to use this email address for your account.", button: "Confirm change" },
  invite: { title: "Accept invitation", body: "Continue to set up your account.", button: "Continue" },
  magiclink: { title: "Sign in", body: "Continue to sign in to SiteInsights.", button: "Sign in" },
};

export function ConfirmClient({ tokenHash, type, next }: { tokenHash: string | null; type: string | null; next: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!tokenHash || !type) {
    return (
      <AuthCard title="Link not valid">
        <Alert tone="error">This link is incomplete or has expired. Request a new one.</Alert>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link href="/sign-in" className="font-medium text-primary hover:underline">Sign in</Link>
          <Link href="/forgot-password" className="font-medium text-primary hover:underline">Reset password</Link>
        </div>
      </AuthCard>
    );
  }
  const c = COPY[type];
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ next: string; signedIn: boolean }>("/api/auth/verify", { method: "POST", json: { token_hash: tokenHash, type, next } });
      if (type === "email_change" && !r.signedIn) {
        setDone("Thanks — this address is confirmed. If your project requires confirming both addresses, also open the link sent to the other one.");
        setBusy(false);
        return;
      }
      window.location.assign(r.signedIn ? r.next : "/sign-in");
    } catch (err) {
      setError((err as ApiClientError).message);
      setBusy(false);
    }
  };
  return (
    <AuthCard busyLabel={busy ? "Verifying your secure link…" : undefined} title={c.title} description={c.body}>
      {error ? (
        <Alert tone="error">
          {error}{" "}
          {type === "recovery" ? <Link href="/forgot-password" className="font-medium underline">Request a new reset link</Link> : <Link href="/sign-in" className="font-medium underline">Go to sign in</Link>}
        </Alert>
      ) : null}
      {done ? (
        <Alert tone="success">{done}</Alert>
      ) : (
        <Button className="w-full" onClick={confirm} disabled={busy} aria-busy={busy}>
          {busy ? <Spinner /> : null}
          {busy ? "Verifying…" : c.button}
        </Button>
      )}
    </AuthCard>
  );
}
