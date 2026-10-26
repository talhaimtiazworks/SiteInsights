"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ApiClientError } from "@/lib/client/api";
import { Alert, Button } from "./ui";

export type ErrorDescription = { title: string; body: ReactNode; tone: "error" | "warning"; retryable: boolean };

/** Shared wording for API errors that aren't specific to one page. */
export function describeApiError(error: unknown, what = "this page"): ErrorDescription {
  const e = error instanceof ApiClientError ? error : new ApiClientError(0, "unexpected_response", "Something went wrong.");
  switch (e.code) {
    case "network_error":
      return { tone: "warning", retryable: true, title: "Can't reach SiteInsights", body: "Check your internet connection and try again." };
    case "database_unavailable":
      return { tone: "warning", retryable: true, title: "Storage is temporarily unavailable", body: "Your data is safe, but it can't be loaded right now. Try again in a moment." };
    case "too_many_requests":
      return { tone: "warning", retryable: true, title: "Too many requests", body: "Wait a few seconds, then try again." };
    case "unexpected_response":
      return { tone: "warning", retryable: true, title: `Couldn't load ${what}`, body: "The server sent an unexpected response. Try again." };
    case "storage_not_configured":
      return {
        tone: "error",
        retryable: false,
        title: "Audit storage isn't set up",
        body: (
          <>
            This deployment has no database, so audits can&apos;t be saved. If you run this site, set <code className="font-mono">DATABASE_URL</code> and redeploy — see{" "}
            <Link href="/help#storage" className="underline">storage setup</Link>.
          </>
        ),
      };
    case "database_busy":
      return { tone: "warning", retryable: true, title: "Storage is busy", body: e.message };
    case "database_misconfigured":
    case "database_schema_missing":
    case "database_schema_outdated":
    case "database_migration_failed":
    case "database_permission_denied":
    case "database_read_only":
    case "supabase_project_mismatch":
      // Needs the site operator; retrying won't help. The message names the problem without technical details.
      return { tone: "error", retryable: false, title: "Audit storage needs attention", body: e.message };
    default:
      return { tone: "error", retryable: e.status === 0 || e.status >= 500, title: `Couldn't load ${what}`, body: e.message };
  }
}

/** Inline (in-card) error with an optional retry button. */
export function InlineError({ error, what, onRetry, busy }: { error: unknown; what?: string; onRetry?: () => void; busy?: boolean }) {
  const d = describeApiError(error, what);
  return (
    <div className="p-4" role="alert">
      <Alert tone={d.tone} title={d.title}>
        {d.body}
        {d.retryable && onRetry ? (
          <div className="mt-3">
            <Button size="sm" variant="outline" onClick={onRetry} disabled={busy}>
              {busy ? "Retrying…" : "Try again"}
            </Button>
          </div>
        ) : null}
      </Alert>
    </div>
  );
}
