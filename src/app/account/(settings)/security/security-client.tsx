"use client";

import { useState } from "react";
import { Field, PasswordInput, passwordProblem } from "@/components/auth-ui";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InlineError } from "@/components/load-error";
import { SettingsSkeleton } from "@/components/skeletons";
import { Alert, Button, Card, CardHeader, PageHeader, Spinner } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { signOut } from "@/lib/client/session";
import { useAccount } from "@/lib/client/use-account";

export function SecurityClient() {
  const { data, error, loading, reload } = useAccount();
  const [current, setCurrent] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [globalOpen, setGlobalOpen] = useState(false);
  const [globalBusy, setGlobalBusy] = useState(false);

  if (error) return <Card><InlineError error={error} what="your security settings" onRetry={reload} busy={loading} /></Card>;
  if (!data) return <SettingsSkeleton label="Loading security settings" embedded />;
  const hasPassword = data.user.providers.includes("email");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (hasPassword && !current) errs.current = "Enter your current password.";
    const p = passwordProblem(pw);
    if (p) errs.pw = p;
    else if (pw !== confirm) errs.confirm = "Passwords don't match.";
    setFe(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/auth/update-password", { method: "POST", json: { password: pw, currentPassword: hasPassword ? current : undefined } });
      setMsg({ tone: "success", text: hasPassword ? "Password changed." : "Password set. You can now also sign in with your email and password." });
      setCurrent("");
      setPw("");
      setConfirm("");
      if (!hasPassword) reload();
    } catch (err) {
      const e2 = err as ApiClientError;
      if (e2.code === "current_password_incorrect" || e2.code === "current_password_required") setFe({ current: e2.message });
      else setMsg({ tone: "error", text: e2.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Security" description="Manage your password and signed-in sessions." />
      {data.user.isSso ? (
        <Alert tone="info">You sign in through your organization&apos;s single sign-on. Password and session policies are managed by your identity provider.</Alert>
      ) : (
        <Card>
          <CardHeader title={hasPassword ? "Change password" : "Set a password"} description={hasPassword ? undefined : "You currently sign in with a connected account. Add a password to also sign in with your email."} />
          <form onSubmit={submit} noValidate className="space-y-4 p-5">
            {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
            {hasPassword ? (
              <Field label="Current password" htmlFor="current" error={fe.current}>
                <PasswordInput id="current" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} invalid={!!fe.current} />
              </Field>
            ) : null}
            <Field label="New password" htmlFor="pw" error={fe.pw} hint="At least 8 characters.">
              <PasswordInput id="pw" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} invalid={!!fe.pw} />
            </Field>
            <Field label="Confirm new password" htmlFor="confirm" error={fe.confirm}>
              <PasswordInput id="confirm" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} invalid={!!fe.confirm} />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" disabled={busy}>{busy ? <Spinner /> : null}{hasPassword ? "Change password" : "Set password"}</Button>
            </div>
          </form>
        </Card>
      )}
      <Card>
        <CardHeader title="Sessions" description="Sessions stay signed in until you sign out or they expire." />
        <div className="flex flex-wrap gap-2 p-5">
          <Button variant="outline" onClick={() => signOut("/")}>Sign out of this device</Button>
          <Button variant="outline" onClick={() => setGlobalOpen(true)}>Sign out everywhere</Button>
        </div>
      </Card>
      <ConfirmDialog
        open={globalOpen}
        title="Sign out everywhere?"
        confirmLabel="Sign out everywhere"
        busy={globalBusy}
        onClose={() => setGlobalOpen(false)}
        onConfirm={async () => {
          setGlobalBusy(true);
          await signOut("/sign-in", "global");
        }}
      >
        <p>This signs you out on every device and browser, including this one. Other devices are signed out the next time they refresh their session (within about an hour at most).</p>
      </ConfirmDialog>
    </div>
  );
}
