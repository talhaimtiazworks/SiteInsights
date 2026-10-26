"use client";

import { ApiClientError } from "@/lib/client/api";
import { describeApiError } from "./load-error";
import { Alert, Button, ButtonLink } from "./ui";

/** Errors after which retrying cannot help. */
export const PERMANENT_SCAN_ERRORS = new Set(["not_found", "session_missing", "session_expired", "auth_required", "storage_not_configured"]);

export function isPermanentScanError(e: unknown): boolean {
  return e instanceof ApiClientError && PERMANENT_SCAN_ERRORS.has(e.code);
}

/**
 * One place that turns API errors for a scan into clear, distinct messages.
 * "Not found" is only shown when the server actually said not_found.
 */
export function ScanAccessError({ error, onRetry, what = "audit" }: { error: ApiClientError; onRetry?: () => void; what?: "audit" | "report" | "issue" }) {
  let title: string;
  let body: React.ReactNode;
  let tone: "error" | "warning" = "error";
  let retry = !!onRetry;
  const needsSignIn = ["auth_required", "session_expired", "session_missing"].includes(error.code);
  const destination = typeof window === "undefined" ? "/dashboard/audits" : window.location.pathname + window.location.search;
  switch (error.code) {
    case "auth_required":
    case "session_expired":
      title = "Sign in to continue";
      body = "Your account session could not be verified. Sign in again to view or continue this audit. No new audit will run automatically.";
      retry = false;
      break;
    case "not_found":
      title = what === "issue" ? "Issue not found" : "Audit not found";
      body =
        what === "issue"
          ? "This issue isn't part of the audit. The link may be outdated."
          : "This audit isn't in your account or a team you can access. Make sure you're signed in to the correct account. Older audits are removed when your history is full.";
      retry = false;
      break;
    case "session_missing":
      title = "Browser session not found";
      body = "Please sign in to the account that owns this audit. Report URLs and old access keys do not grant access without a verified account.";
      retry = false;
      break;
    default: {
      const d = describeApiError(error, `this ${what}`);
      title = d.title;
      body = d.body;
      tone = d.tone;
      retry = retry && d.retryable;
    }
  }
  return (
    <div className="container max-w-2xl py-16" role="alert">
      <Alert tone={tone} title={title}>{body}</Alert>
      <div className="mt-6 flex flex-wrap gap-3">
        {needsSignIn ? <ButtonLink href={`/sign-in?next=${encodeURIComponent(destination)}`}>Sign in again</ButtonLink> : retry ? <Button onClick={onRetry}>Try again</Button> : <ButtonLink href="/audit/new">Start a new audit</ButtonLink>}
        <ButtonLink href="/dashboard" variant="outline">Dashboard</ButtonLink>
      </div>
    </div>
  );
}
