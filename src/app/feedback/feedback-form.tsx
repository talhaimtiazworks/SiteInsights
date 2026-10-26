"use client";

import { useState } from "react";
import { api, ApiClientError } from "@/lib/client/api";
import { signInRedirect } from "@/app/dashboard/dashboard-client";
import { Alert, Button, ButtonLink, Card, Spinner } from "@/components/ui";

const CATEGORIES = [
  ["general", "General feedback"],
  ["bug", "Bug report"],
  ["feature", "Feature request"],
  ["other", "Other"],
] as const;

const MESSAGE_MIN = 20;
const MESSAGE_MAX = 4000;
const GOAL_MAX = 1000;

type Category = (typeof CATEGORIES)[number][0];

interface SubmitResponse {
  delivered: boolean;
  alreadyRecorded?: boolean;
  submissionId?: string; /* absent when recovered via /api/feedback/retry (row is server-side there) */
}

/**
 * One idempotency key per logical form: generated once per mount and kept across
 * retries, so a retried/doubled submit records one row in the database and the
 * provider can be asked at most once per uncertain outcome (see services/feedback).
 */
export function FeedbackForm() {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [category, setCategory] = useState<Category>("general");
  const [rating, setRating] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SubmitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recoverable, setRecoverable] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const trimmed = message.trim();
  const messageTooShort = trimmed.length > 0 && trimmed.length < MESSAGE_MIN;
  const canSubmit = !busy && trimmed.length >= MESSAGE_MIN && trimmed.length <= MESSAGE_MAX && goal.trim().length <= GOAL_MAX;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setRecoverable(false);
    try {
      const res = await api<SubmitResponse>("/api/feedback", {
        method: "POST",
        json: {
          category,
          ...(rating !== null ? { rating } : {}),
          message: trimmed,
          ...(goal.trim() ? { goal: goal.trim() } : {}),
          pageUrl: window.location.pathname.startsWith("/") ? window.location.pathname : undefined,
          idempotencyKey,
        },
      });
      setDone(res);
    } catch (e) {
      if (e instanceof ApiClientError && signInRedirect(e)) return;
      setRecoverable(
        e instanceof ApiClientError && (e.code === "email_not_configured" || e.code === "feedback_delivery_failed"),
      );
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  /** Retry delivery of the saved submission — same server-side row, at most one email. */
  async function retryDelivery() {
    setRetrying(true);
    try {
      const res = await api<{ delivered: number; stillPending: number }>("/api/feedback/retry", { method: "POST" });
      if (res.delivered > 0) setDone({ delivered: true });
      else setError("The email provider still could not deliver the saved submission. It remains queued — nothing was lost.");
    } catch (e) {
      if (e instanceof ApiClientError && signInRedirect(e)) return;
      setError(e instanceof Error ? e.message : "Retry failed. The saved submission is unchanged.");
    } finally {
      setRetrying(false);
    }
  }

  if (done) {
    return (
      <Card className="p-6 sm:p-8" role="status" aria-live="polite">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-success/15 text-success">
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
        <h2 className="mt-4 text-center font-display text-xl font-semibold">Thank you — your feedback is in the maintainer&apos;s inbox.</h2>
        <p className="mx-auto mt-2 max-w-md text-center text-sm leading-6 text-secondary">
          {done.alreadyRecorded
            ? "This exact submission was already recorded on your account — nothing was sent twice."
            : "It was saved to your account and emailed just now. If a follow-up is needed, we reply to your account email."}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <ButtonLink href="/dashboard" variant="secondary">Back to dashboard</ButtonLink>
          <ButtonLink href="/audit/new">Run another audit</ButtonLink>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6 sm:p-8">
      <form onSubmit={submit} className="grid gap-6">
      {error ? (
        <Alert tone="error" title="Couldn't send that">
          <p>{error}</p>
          {recoverable ? (
            <div className="mt-3">
              <Button type="button" variant="secondary" size="sm" disabled={retrying} onClick={() => void retryDelivery()}>
                {retrying ? <Spinner className="mr-2" /> : null}
                Retry email delivery
              </Button>
              <p className="mt-1.5 text-xs text-muted-foreground">Your feedback stays saved either way — delivery is attempted at most once.</p>
            </div>
          ) : null}
        </Alert>
      ) : null}
        <div>
          <label htmlFor="fb-category" className="mb-1.5 block text-sm font-medium">What kind of feedback is this?</label>
          <select
            id="fb-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
            className="w-full rounded-lg border border-border bg-card px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--ring))]"
          >
            {CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">How satisfied are you overall? <span className="font-normal text-muted-foreground">(optional)</span></legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Satisfaction from 1, poor, to 5, excellent">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={rating === n}
                onClick={() => setRating((r) => (r === n ? null : n))}
                className={`h-10 w-10 rounded-lg border text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--ring))] ${
                  rating === n ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-muted"
                }`}
              >
                {n}
              </button>
            ))}
            {rating !== null ? <span className="self-center text-xs text-muted-foreground">Tap again to clear</span> : null}
          </div>
        </fieldset>

        <div>
          <label htmlFor="fb-message" className="mb-1.5 block text-sm font-medium">
            Your feedback <span className="text-danger">*</span>
          </label>
          <textarea
            id="fb-message"
            required
            minLength={MESSAGE_MIN}
            maxLength={MESSAGE_MAX}
            rows={6}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            aria-describedby="fb-message-help fb-message-count"
            aria-invalid={messageTooShort}
            placeholder="What did you use SiteInsights for, and what happened? Include a page or audit name if it helps."
            className="w-full rounded-lg border border-border bg-card px-3 py-2.5 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--ring))]"
          />
          <div className="mt-1 flex items-baseline justify-between gap-3">
            <p id="fb-message-help" className="text-xs text-muted-foreground">
              {messageTooShort ? `At least ${MESSAGE_MIN} characters — a couple of honest sentences.` : `Between ${MESSAGE_MIN} and ${MESSAGE_MAX.toLocaleString()} characters.`}
            </p>
            <p id="fb-message-count" aria-live="polite" className={`font-mono text-[11px] ${trimmed.length > MESSAGE_MAX ? "text-danger" : "text-muted-foreground"}`}>
              {trimmed.length.toLocaleString()}/{MESSAGE_MAX.toLocaleString()}
            </p>
          </div>
        </div>

        <div>
          <label htmlFor="fb-goal" className="mb-1.5 block text-sm font-medium">What were you trying to accomplish? <span className="font-normal text-muted-foreground">(optional)</span></label>
          <input
            id="fb-goal"
            maxLength={GOAL_MAX}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. Audit a client site before a proposal"
            className="w-full rounded-lg border border-border bg-card px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--ring))]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="lg" disabled={!canSubmit} aria-disabled={!canSubmit}>
            {busy ? <Spinner className="h-4 w-4" /> : null}
            {busy ? "Sending…" : "Send feedback"}
          </Button>
          <p className="text-xs text-muted-foreground">Goes to the fixed maintainer inbox. Your message is saved with your account; nothing is published.</p>
        </div>
      </form>
    </Card>
  );
}
