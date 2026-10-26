import type { z } from "zod";
import { AIProviderError } from "./errors";
import type { AIGenerateRequest, AIGenerateResult, AIProvider } from "./types";

/** Extracts the first JSON object from model output (tolerates code fences / prose). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    /* fall through */
  }
  const start = candidate.indexOf("{");
  if (start === -1) throw new SyntaxError("No JSON object found");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new SyntaxError("Unterminated JSON object");
}

export interface StructuredResult<T> {
  data: T;
  meta: Omit<AIGenerateResult, "text">;
  attempts: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls a provider and validates the response against a Zod schema.
 * Bounded retries: transient errors (timeouts, 429, 5xx, network) and invalid
 * output are retried up to `maxRetries` times with backoff; auth/quota/model
 * errors fail immediately.
 */
export async function generateStructured<T>(provider: AIProvider, req: AIGenerateRequest, schema: z.ZodType<T>, opts: { maxRetries: number; baseDelayMs?: number }): Promise<StructuredResult<T>> {
  let lastErr: AIProviderError | null = null;
  let request = { ...req, json: true };
  const baseDelay = opts.baseDelayMs ?? 800;
  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
    try {
      const res = await provider.generate(request);
      let parsed: unknown;
      try {
        parsed = extractJson(res.text);
      } catch {
        throw new AIProviderError("invalid_response", provider.id, null, "The AI response was not valid JSON.");
      }
      const v = schema.safeParse(parsed);
      if (!v.success) throw new AIProviderError("invalid_response", provider.id, null, "The AI response did not match the required structure.");
      const { text: _t, ...meta } = res;
      void _t;
      return { data: v.data, meta, attempts: attempt };
    } catch (err) {
      const e = err instanceof AIProviderError ? err : new AIProviderError("network_error", provider.id);
      lastErr = e;
      if (!e.retryable || attempt > opts.maxRetries) break;
      if (e.code === "invalid_response") {
        request = { ...req, json: true, user: `${req.user}\n\nIMPORTANT: Your previous reply was not valid. Reply with ONE JSON object that exactly matches the schema. No markdown, no prose.` };
      }
      await sleep(Math.min(e.retryAfterMs ?? baseDelay * 2 ** (attempt - 1), 8000));
    }
  }
  throw lastErr ?? new AIProviderError("network_error", provider.id);
}
