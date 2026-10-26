"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthCard, Field } from "@/components/auth-ui";
import { Alert, Button, Input, Spinner } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";

export function SsoClient({ enabled, next }: { enabled: boolean; next: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = next !== "/dashboard" ? `?next=${encodeURIComponent(next)}` : "";

  if (!enabled) {
    return (
      <AuthCard title="Single sign-on" footer={<Link href={`/sign-in${q}`} className="font-medium text-primary hover:underline">Back to sign in</Link>}>
        <Alert tone="info">Single sign-on isn&apos;t enabled on this deployment. Sign in with your email and password or another available method.</Alert>
      </AuthCard>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>("/api/auth/sso", { method: "POST", json: { email, next } });
      window.location.assign(url);
    } catch (err) {
      setError((err as ApiClientError).message);
      setBusy(false);
    }
  };

  return (
    <AuthCard busyLabel={busy ? "Connecting to your identity provider…" : undefined} title="Sign in with SSO" description="Use your company's identity provider (SAML 2.0). We'll find it from your email domain." footer={<Link href={`/sign-in${q}`} className="font-medium text-primary hover:underline">Use another sign-in method</Link>}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <form onSubmit={submit} className="space-y-4">
        <Field label="Work email" htmlFor="email" hint="Only domains your organization has set up for SSO will work.">
          <Input id="email" type="email" autoComplete="email" inputMode="email" required placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" disabled={busy || !email.includes("@")} aria-busy={busy}>
          {busy ? <Spinner /> : null}
          {busy ? "Connecting…" : "Continue with SSO"}
        </Button>
      </form>
    </AuthCard>
  );
}
