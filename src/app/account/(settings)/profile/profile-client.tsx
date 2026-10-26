"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Avatar } from "@/components/account-menu";
import { Field } from "@/components/auth-ui";
import { InlineError } from "@/components/load-error";
import { SettingsSkeleton } from "@/components/skeletons";
import { Alert, Button, Card, CardHeader, Input, PageHeader, Spinner } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { formatDateTime } from "@/lib/client/format";
import { refreshSession } from "@/lib/client/session";
import { useAccount } from "@/lib/client/use-account";
import type { AccountResponse } from "@/lib/client/types";

type Notice = { tone: "success" | "error"; text: string };

function errorText(error: unknown, fallback: string) {
  if (error instanceof ApiClientError || error instanceof Error) return error.message;
  return fallback;
}

export function ProfileClient() {
  const { data, error, loading, reload, setData } = useAccount();
  const params = useSearchParams();
  const [name, setName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<Notice | null>(params.get("email") === "changed" ? { tone: "success", text: "Your email address was updated." } : null);
  const [email, setEmail] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState<Notice | null>(null);

  if (error) return <Card><InlineError error={error} what="your profile" onRetry={reload} busy={loading} /></Card>;
  if (!data) return <SettingsSkeleton label="Loading profile" embedded />;
  const p = data.profile;
  const nameVal = name ?? p.displayName ?? "";
  const dirty = nameVal !== (p.displayName ?? "");

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      // Only editable profile fields are sent. The avatar is derived from the
      // server-validated current auth session and cannot be changed by this form.
      const r = await api<{ profile: AccountResponse["profile"] }>("/api/account/profile", {
        method: "PATCH",
        json: { displayName: nameVal.trim() || null },
      });
      setData((current) => current ? { ...current, profile: r.profile } : current);
      setName(null);
      setMsg({ tone: "success", text: "Profile saved." });
      void refreshSession(true);
    } catch (err) {
      setMsg({ tone: "error", text: errorText(err, "Your profile could not be saved. Please try again.") });
    } finally {
      setSaving(false);
    }
  };

  const changeEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setEmailMsg({ tone: "error", text: "Enter a valid email address." });
    setEmailBusy(true);
    setEmailMsg(null);
    try {
      await api("/api/account/email", { method: "POST", json: { email } });
      setEmailMsg({ tone: "success", text: `We sent a confirmation link to ${email}. Your email changes once you confirm it${data.user.providers.includes("email") ? " (you may also need to confirm from your current address)" : ""}.` });
      setEmail("");
    } catch (err) {
      setEmailMsg({ tone: "error", text: errorText(err, "The confirmation email could not be sent. Please try again.") });
    } finally {
      setEmailBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Profile" description={`Member since ${formatDateTime(p.createdAt)}.`} />
      <Card>
        <CardHeader title="Your details" />
        <form onSubmit={save} className="space-y-5 p-5">
          {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}

          <section aria-labelledby="profile-avatar-title" className="flex flex-col gap-5 rounded-xl border bg-muted/20 p-4 sm:flex-row sm:items-center sm:p-5">
            <div className="flex shrink-0 justify-center sm:justify-start">
              <Avatar name={nameVal || null} email={p.email} url={p.avatarUrl} className="h-24 w-24 text-2xl ring-4 ring-[#F4B43B] ring-offset-2 ring-offset-card" />
            </div>
            <div className="min-w-0 flex-1 space-y-2.5 text-center sm:text-left">
              <h3 id="profile-avatar-title" className="font-semibold text-[#0E436B]">Profile avatar</h3>
              <p className="text-sm text-muted-foreground">
                A validated GitHub profile image appears when available for your current GitHub sign-in. Email/password, Google, SSO, and other sign-ins use your initials. If the image cannot load, your initials appear instead.
              </p>
            </div>
          </section>

          <Field label="Display name" htmlFor="displayName">
            <Input id="displayName" value={nameVal} maxLength={80} autoComplete="name" onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" disabled={!dirty || saving}>{saving ? <Spinner /> : null}Save changes</Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader title="Email address" description={data.user.email ?? "No email on file"} />
        {data.user.isSso ? (
          <p className="p-5 text-sm text-muted-foreground">Your email is managed by your organization&apos;s single sign-on provider.</p>
        ) : (
          <form onSubmit={changeEmail} className="space-y-4 p-5">
            {emailMsg ? <Alert tone={emailMsg.tone}>{emailMsg.text}</Alert> : null}
            <Field label="New email address" htmlFor="newEmail">
              <Input id="newEmail" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" variant="outline" disabled={!email || emailBusy}>{emailBusy ? <Spinner /> : null}Send confirmation link</Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
