import type { AIGenerateRequest, AIGenerateResult, AIProvider, FetchLike, ProviderHealth } from "../types";
import { AIProviderError, codeFromStatus, parseRetryAfter, safeErrorHint, wrapNetworkError } from "../errors";

/**
 * OpenRouter adapter — official Chat Completions API
 * (POST https://openrouter.ai/api/v1/chat/completions). Server-side only.
 */
export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export interface OpenRouterOptions {
  /** Mandatory user-supplied key (BYOK). There is no server-side default. */
  apiKey: string;
  model: string;
  timeoutMs: number;
  appUrl: string | null;
  fetchImpl?: FetchLike;
}

export class OpenRouterProvider implements AIProvider {
  readonly id = "openrouter" as const;
  readonly label = "OpenRouter";
  readonly model: string;
  // True JS private field: the user's key cannot leak via serialization or enumeration.
  readonly #apiKey: string;
  private readonly timeoutMs: number;
  private readonly appUrl: string | null;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OpenRouterOptions) {
    this.#apiKey = opts.apiKey;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs;
    this.appUrl = opts.appUrl;
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "SiteInsights",
    };
    if (this.appUrl) h["HTTP-Referer"] = this.appUrl;
    return h;
  }

  async generate(req: AIGenerateRequest, signal?: AbortSignal): Promise<AIGenerateResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      max_tokens: req.maxOutputTokens,
      temperature: req.temperature ?? 0.2,
    };
    if (req.json) body.response_format = { type: "json_object" };
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      res = await this.fetchImpl(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      throw wrapNetworkError(err, this.id);
    }
    if (!res.ok) {
      const hint = await safeErrorHint(res);
      throw new AIProviderError(codeFromStatus(res.status, hint), this.id, res.status, undefined, parseRetryAfter(res.headers.get("retry-after")));
    }
    let data: {
      model?: string;
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string; code?: number };
    };
    try {
      data = await res.json();
    } catch {
      throw new AIProviderError("invalid_response", this.id, res.status);
    }
    // OpenRouter can return HTTP 200 with an error object (e.g. upstream failure mid-request).
    if (data.error) {
      const status = typeof data.error.code === "number" ? data.error.code : 502;
      throw new AIProviderError(codeFromStatus(status, String(data.error.message ?? "")), this.id, status);
    }
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? "";
    if (choice?.finish_reason === "content_filter") throw new AIProviderError("content_blocked", this.id, res.status);
    if (!text.trim()) throw new AIProviderError("invalid_response", this.id, res.status, "The AI provider returned an empty response.");
    return {
      text,
      provider: this.id,
      model: data.model ?? this.model,
      usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const started = Date.now();
    try {
      // GET /key validates the key without generating tokens.
      const res = await this.fetchImpl(`${OPENROUTER_BASE}/key`, { method: "GET", headers: this.headers(), signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)) });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        const code = codeFromStatus(res.status, await safeErrorHint(res));
        return { provider: this.id, ok: false, code, message: new AIProviderError(code, this.id).message, latencyMs, checkedAt };
      }
      const data = (await res.json().catch(() => ({}))) as { data?: { limit_remaining?: number | null } };
      if (typeof data?.data?.limit_remaining === "number" && data.data.limit_remaining <= 0) {
        return { provider: this.id, ok: false, code: "quota_exhausted", message: "The API key's credit limit is exhausted.", latencyMs, checkedAt };
      }
      return { provider: this.id, ok: true, code: "ok", message: `API key accepted. Model: ${this.model}.`, latencyMs, checkedAt };
    } catch (err) {
      const e = wrapNetworkError(err, this.id);
      return { provider: this.id, ok: false, code: e.code, message: e.message, latencyMs: Date.now() - started, checkedAt };
    }
  }
}
