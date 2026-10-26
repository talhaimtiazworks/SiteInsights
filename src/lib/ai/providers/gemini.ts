import type { AIGenerateRequest, AIGenerateResult, AIProvider, FetchLike, ProviderHealth } from "../types";
import { AIProviderError, codeFromStatus, parseRetryAfter, safeErrorHint, wrapNetworkError } from "../errors";

/**
 * Google Gemini adapter — documented Gemini API REST endpoint
 * (POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent).
 * The key is sent in the x-goog-api-key header (never in the URL, so it cannot leak via logs).
 */
export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiOptions {
  /** Mandatory user-supplied key (BYOK). There is no server-side default. */
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

function modelPath(model: string): string {
  const m = model.startsWith("models/") ? model.slice(7) : model;
  return `models/${encodeURIComponent(m)}`;
}

export class GeminiProvider implements AIProvider {
  readonly id = "gemini" as const;
  readonly label = "Google Gemini";
  readonly model: string;
  // True JS private field: non-enumerable, non-serializable, unreachable from
  // outside this class. The key can never leak via JSON.stringify or spreads.
  readonly #apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: GeminiOptions) {
    this.#apiKey = opts.apiKey;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  }

  private headers(): Record<string, string> {
    return { "x-goog-api-key": this.#apiKey, "Content-Type": "application/json" };
  }

  async generate(req: AIGenerateRequest, signal?: AbortSignal): Promise<AIGenerateResult> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      generationConfig: {
        temperature: req.temperature ?? 0.2,
        maxOutputTokens: req.maxOutputTokens,
        ...(req.json ? { responseMimeType: "application/json" } : {}),
      },
    };
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      res = await this.fetchImpl(`${GEMINI_BASE}/${modelPath(this.model)}:generateContent`, {
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
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      modelVersion?: string;
    };
    try {
      data = await res.json();
    } catch {
      throw new AIProviderError("invalid_response", this.id, res.status);
    }
    if (data.promptFeedback?.blockReason) throw new AIProviderError("content_blocked", this.id, res.status);
    const cand = data.candidates?.[0];
    if (cand?.finishReason && ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(cand.finishReason)) {
      throw new AIProviderError("content_blocked", this.id, res.status);
    }
    const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
    if (!text.trim()) {
      const msg = cand?.finishReason === "MAX_TOKENS" ? "The AI response was cut off before completion (output token limit)." : "The AI provider returned an empty response.";
      throw new AIProviderError("invalid_response", this.id, res.status, msg);
    }
    return {
      text,
      provider: this.id,
      model: data.modelVersion ?? this.model,
      usage: { inputTokens: data.usageMetadata?.promptTokenCount, outputTokens: data.usageMetadata?.candidatesTokenCount },
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    
    const started = Date.now();
    try {
      // GET models/{model} validates key + model without generating tokens.
      const res = await this.fetchImpl(`${GEMINI_BASE}/${modelPath(this.model)}`, { method: "GET", headers: this.headers(), signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)) });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        const code = codeFromStatus(res.status, await safeErrorHint(res));
        return { provider: this.id, ok: false, code, message: new AIProviderError(code, this.id).message, latencyMs, checkedAt };
      }
      return { provider: this.id, ok: true, code: "ok", message: `API key accepted. Model: ${this.model}.`, latencyMs, checkedAt };
    } catch (err) {
      const e = wrapNetworkError(err, this.id);
      return { provider: this.id, ok: false, code: e.code, message: e.message, latencyMs: Date.now() - started, checkedAt };
    }
  }
}
