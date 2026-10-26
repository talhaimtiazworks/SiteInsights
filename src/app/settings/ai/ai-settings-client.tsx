"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { InlineError } from "@/components/load-error";
import { SettingsSkeleton } from "@/components/skeletons";
import { Alert, Badge, Button, Card, CardHeader, Input, PageHeader, Spinner, cn } from "@/components/ui";
import { connectAiSession, disconnectAiSession, useAiSession } from "@/lib/client/ai-session";
import { api, ApiClientError } from "@/lib/client/api";
import { formatDateTime } from "@/lib/client/format";
import type { ProvidersResponse } from "@/lib/client/types";

type ProviderId = "openrouter" | "gemini";
interface Health { provider: string; ok: boolean; code: string; message: string; latencyMs: number | null; checkedAt: string }

export function AiSettingsClient({ embedded = false }: { embedded?: boolean } = {}) {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const session = useAiSession();

  const [providerId, setProviderId] = useState<ProviderId>("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<"test" | "connect" | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pref, setPref] = useState<string>("");
  const [savingPref, setSavingPref] = useState(false);
  const [savedPref, setSavedPref] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    api<ProvidersResponse>("/api/ai/providers")
      .then((d) => {
        setData(d);
        if (d.userPreference) setPref(d.userPreference);
        if (d.providers.length && !d.providers.some((p) => p.id === providerId)) {
          setProviderId(d.providers[0].id as ProviderId);
        }
        setLoadError(null);
      })
      .catch(setLoadError)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot load; providerId is a stable default.
  }, []);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  async function callHealth(p: ProviderId, key: string): Promise<Health> {
    return api<Health>("/api/ai/health", { method: "POST", json: { provider: p, apiKey: key } });
  }

  function handleFailure(e: unknown): Health {
    const err = e as ApiClientError;
    return { provider: providerId, ok: false, code: err.code || "error", message: err.message || "The connection test failed.", latencyMs: null, checkedAt: new Date().toISOString() };
  }

  /**
   * Genuine validation: the provider adapter makes a real API call with the
   * entered key. A successful connect is ONLY possible after this succeeds —
   * never from an input format check.
   */
  async function testConnection(): Promise<Health | null> {
    setFormError(null);
    setHealth(null);
    const key = apiKey.trim();
    if (key.length < 8) {
      setFormError("Paste your full provider API key first.");
      inputRef.current?.focus();
      return null;
    }
    setBusy("test");
    try {
      const h = await callHealth(providerId, key);
      setHealth(h);
      return h.ok ? h : null;
    } catch (e) {
      setHealth(handleFailure(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  /** Connect = validate genuinely, then keep the key in memory for this session. */
  async function connect() {
    const okHealth = await testConnection();
    if (!okHealth) return; // failure state is already shown; nothing connects
    connectAiSession(providerId, apiKey.trim(), okHealth.checkedAt);
    setApiKey(""); // the form needn't keep a copy; the session store holds it
    setShowKey(false);
    setHealth(null);
  }

  function disconnect() {
    disconnectAiSession();
    setHealth(null);
    setFormError(null);
  }

  async function savePreference() {
    setSavingPref(true);
    setSavedPref(null);
    try {
      const r = await api<{ preference: string | null; persistent: boolean }>("/api/settings/ai", { method: "PUT", json: { provider: pref || null } });
      setData((d) => (d ? { ...d, userPreference: (r.preference as ProvidersResponse["userPreference"]) ?? null } : d));
      setSavedPref(r.persistent ? "Preference saved." : "Preference saved for this session only (no database configured).");
    } catch (e) {
      setFormError((e as ApiClientError).message);
    } finally {
      setSavingPref(false);
    }
  }

  const providers = data?.providers ?? [];
  const active = providers.find((p) => p.id === providerId);
  const connected = session !== null;

  return (
    <div className={embedded ? "space-y-6" : "container max-w-3xl space-y-6 py-10"}>
      <PageHeader title="AI settings" description="Bring Your Own Key: AI explanations run on your own provider account, never on a shared one." />
      {loadError && !data ? <Card><InlineError error={loadError} what="AI settings" onRetry={load} busy={loading} /></Card> : null}
      {!data && !loadError ? <SettingsSkeleton label="Loading AI settings" /> : null}

      {data ? (
        <>
          <Alert tone="info" title="Your key is never stored">
            Your API key is kept only in this page’s memory and sent with each AI request over an encrypted connection.
            A page refresh, new tab, sign-out or <strong>Disconnect</strong> clears it — you’ll be asked to enter it again.
            SiteInsights never saves it in the database, cookies, browser storage or logs.
          </Alert>
          <Alert tone="warning" title="Charges and quotas are yours">
            AI requests are billed by <strong>your provider account</strong> (OpenRouter or Google) under your own plan and quota.
            SiteInsights charges nothing for AI features; it only sends your verified findings to the provider you choose.
          </Alert>

          <Card>
            <CardHeader title="Connect your provider" description="Signed-in users only. Your key authorizes requests to your own provider account." />
            {connected ? (
              <div className="space-y-4 p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="border-success/30 bg-success-soft text-success">Connected</Badge>
                  <span className="font-medium">{providers.find((p) => p.id === session.provider)?.label ?? session.provider}</span>
                  <span className="text-sm text-muted-foreground">· verified {formatDateTime(session.validatedAt)} · model <span className="font-mono text-xs">{providers.find((p) => p.id === session.provider)?.model}</span></span>
                </div>
                <p className="text-sm text-muted-foreground">AI request controls elsewhere (audit summaries, per-issue explanations) now use this key. It lasts until you disconnect, sign out, or reload the page.</p>
                <div className="flex flex-wrap gap-3">
                  <Button variant="outline" onClick={disconnect}>Disconnect</Button>
                  <Link href="/audit/new" className="text-sm font-medium text-primary hover:underline self-center">Run an audit →</Link>
                </div>
              </div>
            ) : (
              <div className="space-y-4 p-5">
                <div>
                  <p id="ai-provider-legend" className="mb-2 text-sm font-medium">Provider</p>
                  <div role="radiogroup" aria-labelledby="ai-provider-legend" className="grid gap-2 sm:grid-cols-2">
                    {providers.map((p) => (
                      <label key={p.id} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3", providerId === p.id ? "border-primary bg-primary/5" : "hover:bg-muted/40")}>
                        <input type="radio" name="ai-provider" value={p.id} checked={providerId === p.id} onChange={() => { setProviderId(p.id); setHealth(null); setFormError(null); }} className="mt-1" />
                        <span className="min-w-0">
                          <span className="block font-medium">{p.label}</span>
                          <span className="block text-sm text-muted-foreground">{p.keyHelpText}{" "}
                            <a href={p.keyHelpUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">Get your key ↗</a>
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">Default model: <span className="font-mono">{p.model}</span></span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <label htmlFor="byok-key" className="mb-1.5 block text-sm font-medium">Your {active?.label ?? "provider"} API key</label>
                  <div className="flex gap-2">
                    <Input
                      id="byok-key"
                      ref={inputRef}
                      type={showKey ? "text" : "password"}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={active ? active.keyFormatHint : "Paste your API key"}
                      value={apiKey}
                      onChange={(e) => { setApiKey(e.target.value); setHealth(null); setFormError(null); }}
                      className="font-mono text-sm"
                    />
                    <Button type="button" variant="outline" onClick={() => setShowKey((v) => !v)} aria-pressed={showKey} aria-label={showKey ? "Hide API key" : "Show API key"}>
                      {showKey ? "Hide" : "Show"}
                    </Button>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">Held in memory only — refreshing the page always clears it.</p>
                </div>

                {formError ? <Alert tone="error">{formError}</Alert> : null}
                {health ? (
                  <Alert tone={health.ok ? "success" : "error"} title={health.ok ? "Connection verified" : "Connection failed"}>
                    {health.message}
                    {health.latencyMs !== null ? ` (${health.latencyMs} ms)` : ""}
                    {!health.ok ? (
                      <span className="mt-1 block text-xs">
                        Check the key itself, your model access, and your provider balance — then retry. Temporary provider outages can also cause this.
                      </span>
                    ) : null}
                  </Alert>
                ) : null}

                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="outline" onClick={() => void testConnection()} disabled={busy !== null || !apiKey.trim()}>
                    {busy === "test" ? <Spinner /> : null}Test connection
                  </Button>
                  <Button onClick={() => void connect()} disabled={busy !== null || !apiKey.trim()} title="Validates the key with the provider, then keeps it in memory">
                    {busy === "connect" ? <Spinner /> : null}Connect
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Connect runs the same genuine provider check first — a successful connection is only possible after the provider accepts your key.
                </p>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Default provider for AI controls" description="Preselects a provider in AI request forms. Optional — no key is stored with it." />
            <fieldset className="space-y-3 p-5">
              <legend className="sr-only">Default provider preference</legend>
              <div className="flex flex-wrap gap-2">
                <label className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 hover:bg-muted/40 text-sm">
                  <input type="radio" name="pref" value="" checked={pref === ""} onChange={() => setPref("")} /> No preference
                </label>
                {providers.map((p) => (
                  <label key={p.id} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm", pref === p.id ? "border-primary bg-primary/5" : "hover:bg-muted/40")}>
                    <input type="radio" name="pref" value={p.id} checked={pref === p.id} onChange={() => setPref(p.id)} /> {p.label}
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" onClick={() => void savePreference()} disabled={savingPref || pref === (data.userPreference ?? "")}>{savingPref ? <Spinner /> : null}Save preference</Button>
                {savedPref ? <span className="text-sm text-success">{savedPref}</span> : null}
              </div>
            </fieldset>
          </Card>
        </>
      ) : null}
    </div>
  );
}
