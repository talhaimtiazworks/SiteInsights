"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PROVIDER_META } from "@/components/auth-ui";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InlineError } from "@/components/load-error";
import { SettingsSkeleton } from "@/components/skeletons";
import { Alert, Badge, Button, Card, CardHeader, PageHeader, Spinner } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { authErrorMessage } from "@/lib/client/auth-messages";
import { formatDateTime } from "@/lib/client/format";
import { toSignIn } from "@/lib/client/navigate";

interface Identity { identityId: string; provider: string; email: string | null; createdAt: string | null; lastSignInAt: string | null }
interface IdentitiesResponse { identities: Identity[]; available: { google: boolean; github: boolean }; isSso: boolean; hasPassword: boolean }

const NAMES: Record<string, string> = { email: "Email & password", google: "Google", github: "GitHub" };
const providerName = (p: string) => NAMES[p] ?? (p.startsWith("sso:") ? "Single sign-on (SAML)" : p);

export function ConnectionsClient() {
  const params = useSearchParams();
  const [data, setData] = useState<IdentitiesResponse | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Identity | null>(null);
  const linked = params.get("linked");
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(
    params.get("error") ? { tone: "error", text: authErrorMessage(params.get("error"))! } : linked && linked in PROVIDER_META ? { tone: "success", text: `${PROVIDER_META[linked as "google"].label} is now connected.` } : null,
  );

  const load = useCallback(() => {
    setLoading(true);
    api<IdentitiesResponse>("/api/account/identities")
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: ApiClientError) => {
        if (e.status === 401) toSignIn("expired");
        else setError(e);
      })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  if (error) return <Card><InlineError error={error} what="your connected accounts" onRetry={load} busy={loading} /></Card>;
  if (!data) return <SettingsSkeleton label="Loading connected accounts" embedded />;

  const connect = async (provider: "google" | "github") => {
    setBusy(provider);
    setMsg(null);
    try {
      const { url } = await api<{ url: string }>("/api/auth/oauth", { method: "POST", json: { provider, mode: "link" } });
      window.location.assign(url);
    } catch (e) {
      setMsg({ tone: "error", text: (e as ApiClientError).message });
      setBusy(null);
    }
  };
  const connectable = (["google", "github"] as const).filter((p) => data.available[p] && !data.identities.some((i) => i.provider === p));

  return (
    <div className="space-y-6">
      <PageHeader title="Connected accounts" description="Ways you can sign in to SiteInsights." />
      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
      <Card>
        <CardHeader title="Sign-in methods" />
        <ul className="divide-y">
          {data.identities.map((i) => (
            <li key={i.identityId} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{providerName(i.provider)}</p>
                <p className="truncate text-xs text-muted-foreground">{i.email ?? ""}{i.lastSignInAt ? ` · last used ${formatDateTime(i.lastSignInAt)}` : ""}</p>
              </div>
              {data.identities.length > 1 && !data.isSso ? (
                <Button variant="outline" size="sm" onClick={() => setRemoving(i)}>Disconnect</Button>
              ) : (
                <Badge className="text-muted-foreground">{data.identities.length > 1 ? "Managed by SSO" : "Only method"}</Badge>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {!data.isSso ? (
        <Card>
          <CardHeader title="Connect another account" description="Sign in with any connected account. It must use an email you control." />
          <div className="flex flex-wrap gap-2 p-5">
            {connectable.length ? (
              connectable.map((p) => {
                const { label, Icon } = PROVIDER_META[p];
                return (
                  <Button key={p} variant="outline" onClick={() => connect(p)} disabled={busy !== null}>
                    {busy === p ? <Spinner /> : <Icon />}
                    Connect {label}
                  </Button>
                );
              })
            ) : (
              <p className="text-sm text-muted-foreground">{data.available.google || data.available.github ? "All available providers are connected." : "No other sign-in providers are enabled on this deployment."}</p>
            )}
          </div>
          {!data.hasPassword ? <p className="border-t px-5 py-3 text-xs text-muted-foreground">You can also set a password under Security.</p> : null}
        </Card>
      ) : null}
      <ConfirmDialog
        open={!!removing}
        title={`Disconnect ${removing ? providerName(removing.provider) : ""}?`}
        confirmLabel="Disconnect"
        busy={busy === "remove"}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          setBusy("remove");
          try {
            await api(`/api/account/identities/${encodeURIComponent(removing.identityId)}`, { method: "DELETE" });
            setMsg({ tone: "success", text: `${providerName(removing.provider)} was disconnected.` });
            setRemoving(null);
            load();
          } catch (e) {
            setMsg({ tone: "error", text: (e as ApiClientError).message });
            setRemoving(null);
          } finally {
            setBusy(null);
          }
        }}
      >
        <p>You won&apos;t be able to sign in with it anymore. Your audits and settings are not affected.</p>
      </ConfirmDialog>
    </div>
  );
}
