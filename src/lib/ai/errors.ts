import type { ProviderId } from "../config/env";

export type AIErrorCode =
  | "not_configured"
  | "auth_failed"
  | "rate_limited"
  | "quota_exhausted"
  | "timeout"
  | "invalid_response"
  | "model_not_found"
  | "content_blocked"
  | "bad_request"
  | "provider_unavailable"
  | "network_error";

const RETRYABLE: AIErrorCode[] = ["timeout", "rate_limited", "provider_unavailable", "network_error", "invalid_response"];

/**
 * User-facing messages for BYOK failures. Credentials are the CURRENT USER's
 * own key; messages must never echo key material, raw provider bodies, or
 * internal detail, and must say what the user can check themselves.
 */
export const AI_ERROR_MESSAGES: Record<AIErrorCode, string> = {
  not_configured: "No AI key was supplied. Add your own provider key on the AI settings page — SiteInsights never uses a shared or owner key.",
  auth_failed: "The AI provider rejected this API key. Check that it was copied in full and is still active on your provider account.",
  rate_limited: "Your provider account is rate-limiting requests right now. Please try again in a minute.",
  quota_exhausted: "The quota or credit balance on your provider account is exhausted. Check your provider's billing/usage page.",
  timeout: "The AI provider did not respond in time.",
  invalid_response: "The AI provider returned a response that did not match the required format.",
  model_not_found: "This model was not found or is not enabled for your API key. Check model access on your provider account.",
  content_blocked: "The AI provider declined to generate a response for this content.",
  bad_request: "The AI provider rejected the request.",
  provider_unavailable: "The AI provider is temporarily unavailable. Please try again later.",
  network_error: "Could not reach the AI provider.",
};

/**
 * Error raised by provider adapters. `message` is always a safe, user-facing
 * string; raw provider bodies, headers and keys are never included.
 */
export class AIProviderError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: AIErrorCode,
    readonly provider: ProviderId,
    readonly httpStatus: number | null = null,
    message?: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message ?? AI_ERROR_MESSAGES[code]);
    this.retryable = RETRYABLE.includes(code);
  }
}

/** Maps an HTTP status (plus a sanitised hint from the body) to an error code. */
export function codeFromStatus(status: number, hint: string): AIErrorCode {
  const h = hint.toLowerCase();
  if (status === 401) return "auth_failed";
  if (status === 402) return "quota_exhausted";
  if (status === 403) {
    if (/quota|budget|credit|limit/.test(h)) return "quota_exhausted";
    if (/moderation|flagged|safety/.test(h)) return "content_blocked";
    return "auth_failed";
  }
  if (status === 404) return "model_not_found";
  if (status === 408) return "timeout";
  if (status === 429) return /quota|exhausted|billing|credits/.test(h) && !/rate/.test(h) ? "quota_exhausted" : "rate_limited";
  if (status === 400) {
    if (/api key not valid|api_key_invalid|invalid api key/.test(h)) return "auth_failed";
    if (/model/.test(h) && /not found|invalid|does not exist|not a valid/.test(h)) return "model_not_found";
    return "bad_request";
  }
  if (status >= 500) return "provider_unavailable";
  return "bad_request";
}

export function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.min(n * 1000, 60_000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.min(t - Date.now(), 60_000)) : null;
}

/** Converts fetch/abort errors into AIProviderError. */
export function wrapNetworkError(err: unknown, provider: ProviderId): AIProviderError {
  if (err instanceof AIProviderError) return err;
  const name = (err as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") return new AIProviderError("timeout", provider);
  return new AIProviderError("network_error", provider);
}

/** Extracts a short error hint from a provider error body without echoing secrets. */
export async function safeErrorHint(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 2000);
    try {
      const j = JSON.parse(text);
      const msg = j?.error?.message ?? j?.error?.status ?? j?.message ?? "";
      return String(msg).slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return "";
  }
}
