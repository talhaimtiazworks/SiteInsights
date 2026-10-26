"use client";

import { useState } from "react";
import { InlineError } from "@/components/load-error";
import { SettingsSkeleton } from "@/components/skeletons";
import { Alert, Card, CardHeader, PageHeader } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { refreshSession } from "@/lib/client/session";
import type { AccountResponse } from "@/lib/client/types";
import { useAccount } from "@/lib/client/use-account";

export function AppearanceClient() {
  const { data, error, loading, reload, setData } = useAccount();
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  if (error) return <Card><InlineError error={error} what="your settings" onRetry={reload} busy={loading} /></Card>;
  if (!data) return <SettingsSkeleton label="Loading settings" embedded />;

  const save = async (patch: Partial<AccountResponse["settings"]>) => {
    const prev = data.settings;
    setData({ ...data, settings: { ...prev, ...patch } });
    setSaving(true);
    setMsg(null);
    try {
      const r = await api<{ settings: AccountResponse["settings"] }>("/api/account/settings", { method: "PATCH", json: patch });
      setData({ ...data, settings: r.settings });
      setMsg({ tone: "success", text: "Saved." });
      void refreshSession(true);
    } catch (e) {
      setData({ ...data, settings: prev });
      setMsg({ tone: "error", text: (e as ApiClientError).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Audit defaults" description="Saved to your account and applied on every device." />
      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
      <Card>
        <CardHeader title="New audit defaults" description="Which optional checks are preselected when you start an audit. You can still change them per audit." />
        <div className="space-y-3 p-5">
          {([
            ["defaultBrowser", "Browser rendering & accessibility", "Load pages in a real browser to catch JavaScript errors and run accessibility tests."],
            ["defaultPerformance", "Performance test", "Run a Lighthouse lab test on the start page."],
          ] as const).map(([key, label, hint]) => (
            <label key={key} className="flex items-start gap-3">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={data.settings[key]} disabled={saving} onChange={(e) => save({ [key]: e.target.checked })} />
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-xs text-muted-foreground">{hint}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-muted-foreground">Checks that aren&apos;t available on this server stay off regardless of these defaults.</p>
        </div>
      </Card>
    </div>
  );
}
