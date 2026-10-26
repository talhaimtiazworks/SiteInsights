"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { refreshSession, useSession } from "@/lib/client/session";
import { api, ApiClientError } from "@/lib/client/api";
import { formatDateTime, formatNumber } from "@/lib/client/format";
import { useCredits } from "@/lib/client/use-credits";
import { saveScanKey } from "@/lib/client/scan-keys";
import { parseHttpUrlInput } from "@/lib/security/url-input";
import { useSystemStatus } from "./system-notice";
import { Alert, Button, ButtonLink, cn, Spinner } from "./ui";

interface Props {
  size?: "md" | "lg";
  autoFocus?: boolean;
  className?: string;
}

export function UrlForm({ size = "md", autoFocus, className }: Props) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string; retryable?: boolean } | null>(null);
  const [urlValidation, setUrlValidation] = useState<string | null>(null);
  const [urlTouched, setUrlTouched] = useState(false);
  const [authPrompt, setAuthPrompt] = useState(false);
  const status = useSystemStatus();
  const features = status?.features;
  const [checks, setChecks] = useState({ browser: true, accessibility: true, performance: true });
  // Signed-in users' saved defaults (Account → Audit defaults) preselect the checks once.
  const { session, loading: verifying, error: sessionError } = useSession();
  const submitting = useRef(false);
  const defaults = session?.settings;
  const appliedDefaults = useRef(false);
  useEffect(() => {
    if (!defaults || appliedDefaults.current) return;
    appliedDefaults.current = true;
    const t = setTimeout(() => setChecks((c) => ({ ...c, browser: defaults.defaultBrowser, accessibility: defaults.defaultBrowser && c.accessibility, performance: defaults.defaultPerformance })), 0);
    return () => clearTimeout(t);
  }, [defaults]);
  const signedIn = !!session?.user && session.status === "signed_in";
  const credits = useCredits(signedIn);
  const summary = credits.summary;
  const [pages, setPages] = useState<number | null>(null);
  const planMax = summary?.plan.maxPagesPerAudit ?? null;
  // Default to the plan maximum, or the largest audit the balance covers.
  const effectivePages = pages ?? (summary ? summary.plan.maxPagesPerAudit : null);
  // One idempotency key per submission: a retried request returns the same scan instead of starting another.
  const attempt = useRef<{ url: string; key: string } | null>(null);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (submitting.current || busy) return;
    setError(null);
    setAuthPrompt(false);
    setUrlTouched(true);
    const parsed = parseHttpUrlInput(url);
    if (!parsed.ok) {
      setUrlValidation(parsed.message);
      return;
    }
    const value = parsed.normalized;
    setUrl(value);
    setUrlValidation(null);
    const attemptId = `${value}\n${effectivePages ?? ""}`;
    if (!attempt.current || attempt.current.url !== attemptId) attempt.current = { url: attemptId, key: crypto.randomUUID() };
    const { key } = attempt.current;
    submitting.current = true;
    setBusy(true);
    // Only send choices for checks this server offers; the server re-validates everything.
    const payload: { url: string; maxPages?: number; checks?: { browser: boolean; accessibility: boolean; performance: boolean } } = { url: value };
    if (effectivePages) payload.maxPages = effectivePages;
    if (features) payload.checks = { browser: features.browserRendering && checks.browser, accessibility: features.accessibility && checks.browser && checks.accessibility, performance: features.performance && checks.performance };
    const start = () => api<{ id: string; accessKey: string | null }>("/api/scans", { method: "POST", json: payload, headers: { "Idempotency-Key": key } });
    try {
      // Resolve an unknown/guest state for UX, but avoid an extra session GET for
      // known signed-in users: /api/scans verifies the live session before any
      // scan or credit mutation and returns an auth error if it has expired.
      if (!signedIn) {
        const fresh = await refreshSession();
        if (!fresh?.user || fresh.status !== "signed_in") {
          setAuthPrompt(true);
          setBusy(false);
          return;
        }
      }
      let scan: { id: string; accessKey: string | null };
      try {
        scan = await start();
      } catch (err) {
        // The request may have reached the server: retry once with the same key.
        if (!(err instanceof ApiClientError) || (err.status !== 0 && err.code !== "unexpected_response")) throw err;
        await new Promise((r) => setTimeout(r, 1200));
        scan = await start();
      }
      if (scan.accessKey) saveScanKey(scan.id, scan.accessKey);
      attempt.current = null;
      window.dispatchEvent(new Event("siteinsights:navigate"));
      router.push(`/scans/${scan.id}/progress`);
    } catch (err) {
      const e2 = err instanceof ApiClientError ? err : new ApiClientError(0, "unknown", "Something went wrong.");
      const resetAt = typeof e2.details?.resetAt === "string" ? e2.details.resetAt : null;
      // Temporary server/network problems can be retried with the same idempotency key, which returns the
      // already-created audit (if the first request got through) instead of starting a second one.
      const retryable = e2.status === 0 || e2.status >= 500 || e2.code === "unexpected_response";
      if (e2.code === "invalid_url" || e2.code === "unsafe_url") {
        setUrlValidation(e2.message);
        setError(null);
      } else if (e2.code === "auth_required" || e2.code === "session_expired") {
        setAuthPrompt(true);
        setError(null);
      } else {
        setError({ message: e2.message, detail: resetAt ? `You can try again around ${formatDateTime(resetAt)}.` : undefined, retryable });
      }
      if (e2.status >= 400 && e2.status < 500) attempt.current = null; // rejected: nothing was created
      setBusy(false);
    } finally {
      submitting.current = false;
    }
  }

  const big = size === "lg";
  return (
    <form onSubmit={submit} className={cn("w-full", className)} noValidate aria-busy={busy}>
      <label htmlFor="site-url" className="mb-1 block text-sm font-medium text-foreground">
        Website to audit
      </label>
      <p id="url-help" className="mb-3 text-sm leading-6 text-muted-foreground">
        Enter a public website URL. Bare domains use https://; local and internal websites cannot be scanned.
      </p>
      <div className={cn("flex flex-col gap-3 sm:flex-row", big && "sm:rounded-md sm:border sm:border-charcoal/20 sm:bg-card sm:p-1")}>
        <input
          id="site-url"
          name="url"
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          autoFocus={autoFocus}
          placeholder="example.com or https://example.com"
          value={url}
          onChange={(e) => {
            const next = e.target.value;
            setUrl(next);
            setError(null);
            setAuthPrompt(false);
            if (urlTouched) {
              const parsed = parseHttpUrlInput(next);
              setUrlValidation(next.trim() ? (parsed.ok ? null : parsed.message) : null);
            }
          }}
          onBlur={() => {
            setUrlTouched(true);
            if (!url.trim()) { setUrlValidation(null); return; }
            const parsed = parseHttpUrlInput(url);
            if (parsed.ok) { setUrl(parsed.normalized); setUrlValidation(null); }
            else setUrlValidation(parsed.message);
          }}
          disabled={busy}
          aria-invalid={!!urlValidation}
          aria-describedby={urlValidation ? "url-help url-validation" : "url-help"}
          className={cn("w-full min-w-0 truncate rounded-full px-3 py-2 border border-charcoal/20 bg-card text-base placeholder:text-muted-foreground focus:border-primary sm:flex-1", big ? "h-12 sm:border-0 sm:bg-transparent sm:focus:ring-0" : "h-11")}
        />
        {/* shrink-0 + whitespace-nowrap keep the button on one line at every width instead of wrapping ("Start audit" squeezed by the full-width input); w-full+flex-1 lets the input take exactly the remaining space so the placeholder is never covered. */}
        <Button type="submit" size={big ? "lg" : "md"} disabled={busy} className="w-full shrink-0 whitespace-nowrap rounded-full bg-[#e8447a] px-3 py-2 text-white shadow-none hover:bg-[#d13a6f] hover:shadow-none motion-safe:hover:transform-none sm:w-auto">
          {busy ? <Spinner /> : null}
          {busy ? "..." : "Scan Site"}
        </Button>
      </div>
      {urlValidation ? <p id="url-validation" role="alert" className="mt-2 text-left text-sm font-medium text-danger">{urlValidation}</p> : null}
      {verifying ? <p role="status" aria-live="polite" className="mt-2 text-left text-xs text-muted-foreground">Checking your session in the background. You can enter a website while it loads.</p> : null}
      <p role="status" aria-live="polite" className="sr-only">{busy ? "Starting your audit…" : ""}</p>
      {!signedIn && !verifying ? (
        <div className="mt-3 rounded-md border bg-tint p-3 text-left sm:p-4">
          {session?.status === "expired" ? <Alert tone="warning" className="mb-3" title="Your session expired">Sign in again before starting this audit.</Alert> : null}
          {sessionError ? (
            <Alert tone="warning" className="mb-3">
              {sessionError}
              <button type="button" className="ml-2 font-semibold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => void refreshSession(true)}>Retry session check</button>
            </Alert>
          ) : null}
          {authPrompt ? <p role="alert" className="mb-2 text-sm font-medium text-secondary">Sign in or create an account to start this audit. Your website has not been submitted.</p> : null}
          {session?.accountsEnabled === false ? (
            <p className="text-sm text-secondary">Account access is currently unavailable, so an audit cannot be started. You can still review the URL; no scan has been submitted.</p>
          ) : (
            <>
              <p className="text-sm font-medium text-foreground">Sign in to start your audit</p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">Your URL is only submitted after you sign in and explicitly start the audit. New here? Create a free account first.</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <ButtonLink href="/sign-in?next=%2Faudit%2Fnew">Sign in to start</ButtonLink>
                <ButtonLink href="/sign-up?next=%2Faudit%2Fnew" variant="outline">Create a free account</ButtonLink>
              </div>
            </>
          )}
        </div>
      ) : null}
      {summary && planMax ? (
        <div className="mt-3 flex flex-col gap-2 rounded-md border bg-tint px-3 py-2.5 text-left text-sm sm:flex-row sm:items-center sm:justify-between">
          <label className="inline-flex items-center gap-2">
            <span className="text-secondary">Pages</span>
            <input
              type="number"
              min={1}
              max={planMax}
              step={1}
              inputMode="numeric"
              value={effectivePages ?? ""}
              disabled={busy}
              onChange={(e) => {
                const n = Math.floor(Number(e.target.value));
                setPages(Number.isFinite(n) ? Math.max(1, Math.min(planMax, n)) : null);
              }}
              className="h-9 w-20 rounded-md border border-charcoal/20 bg-card px-2 text-right tabular-nums"
            />
            <span className="text-xs text-muted-foreground">of {formatNumber(planMax)} maximum per audit</span>
          </label>
          <p className="text-xs text-secondary">SiteInsights is free — there is no charge and no credit balance to watch.</p>
        </div>
      ) : null}
      {features ? <CheckOptions features={features} checks={checks} onChange={setChecks} disabled={busy} /> : null}
      {error ? (
        <div id="url-error" className="mt-3 text-left">
          <Alert tone="error">
            {error.message}
            {error.detail ? <span className="block">{error.detail}</span> : null}
            {error.retryable ? (
              <span className="mt-2 block">
                <Button type="button" size="sm" variant="outline" onClick={() => void submit()} disabled={busy}>
                  Try again
                </Button>
              </span>
            ) : null}
          </Alert>
        </div>
      ) : null}
    </form>
  );
}

type Checks = { browser: boolean; accessibility: boolean; performance: boolean };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const SHORT: Record<keyof Checks, string> = { browser: "rendered-page tests", accessibility: "accessibility tests", performance: "speed tests" };

function CheckOptions({ features, checks, onChange, disabled }: { features: NonNullable<ReturnType<typeof useSystemStatus>>["features"]; checks: Checks; onChange: (c: Checks) => void; disabled: boolean }) {
  const options: Array<{ key: keyof Checks; label: string; hint: string; available: boolean; requires?: keyof Checks }> = [
    { key: "browser", label: "Browser rendering", hint: `Loads up to ${features.browserPagesPerScan} page${features.browserPagesPerScan === 1 ? "" : "s"} in Chromium to catch JavaScript errors, failed requests and mobile layout issues`, available: features.browserRendering },
    { key: "accessibility", label: "Accessibility (axe-core)", hint: "Automated accessibility tests on the rendered pages", available: features.accessibility, requires: "browser" },
    { key: "performance", label: "Performance", hint: `Lighthouse lab test (${features.performanceStrategies.join(" + ")}) and real-user data where available, for the start page`, available: features.performance },
  ];
  const available = options.filter((o) => o.available);
  const missing = options.filter((o) => !o.available);
  return (
    <fieldset className="mt-3 text-left" disabled={disabled}>
      <legend className="sr-only">Optional checks</legend>
      {available.length ? (
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {available.map((o) => {
            const blocked = o.requires ? !checks[o.requires] : false;
            return (
              <label key={o.key} className={cn("inline-flex min-h-9 cursor-pointer items-center gap-2 text-sm", blocked && "cursor-not-allowed opacity-60")} title={o.hint}>
                <input type="checkbox" className="size-4 accent-[rgb(var(--primary))]" checked={checks[o.key] && !blocked} disabled={blocked} onChange={(e) => onChange({ ...checks, [o.key]: e.target.checked })} />
                {o.label}
              </label>
            );
          })}
        </div>
      ) : null}
      {missing.length ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {available.length ? "" : "Includes SEO, content, link and technical checks. "}
          {missing.length === options.length ? "Rendered-page, accessibility and speed tests aren't enabled on this site." : `${cap(missing.map((o) => SHORT[o.key]).join(" and "))} aren't enabled on this site.`}
        </p>
      ) : null}
    </fieldset>
  );
}
