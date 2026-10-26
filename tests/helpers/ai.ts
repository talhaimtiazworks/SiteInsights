import type { AIConfig } from "@/lib/config/env";
import type { FetchLike } from "@/lib/ai/types";

export function aiConfig(overrides: Partial<AIConfig> = {}): AIConfig {
  return {
    timeoutMs: 5000,
    maxRetries: 1,
    maxOutputTokens: 1000,
    openrouter: { model: "openrouter/auto" },
    gemini: { model: "gemini-flash-latest" },
    ...overrides,
  };
}

export const VALID_EXPLANATION = {
  plainLanguage: "Three pages link to an address that no longer exists.",
  impact: "Visitors hit an error page.",
  recommendation: "Update the links or add a redirect.",
  steps: ["Find the links", "Update them"],
  exampleCode: null,
  priority: "high",
  effort: "quick",
  confirmedFacts: ["The URL returned 404"],
  hypotheses: [],
  limitations: "",
  severityAssessment: { agreesWithScanner: true, suggestedSeverity: null, reasoning: "Broken links hurt users." },
};

export interface Recorded {
  url: string;
  init?: RequestInit;
}

/** Fake fetch returning queued responses; records every request. */
export function fakeFetch(responses: Array<() => Response>): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let i = 0;
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const r = responses[Math.min(i++, responses.length - 1)];
      return r();
    },
  };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
export const openrouterOk = (content: string) => json(200, { model: "openrouter/auto", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
export const geminiOk = (text: string) => json(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } });
