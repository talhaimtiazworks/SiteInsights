import type { AIConfig, ProviderId } from "../config/env";
import { AIProviderError } from "./errors";
import { GeminiProvider } from "./providers/gemini";
import { OpenRouterProvider } from "./providers/openrouter";
import type { AIProvider, FetchLike } from "./types";

export const PROVIDER_IDS: ProviderId[] = ["openrouter", "gemini"];

/** Public documentation for a supported provider (never any credentials). */
export interface ProviderSupportInfo {
  id: ProviderId;
  label: string;
  /** Default model used when a key is supplied (operator may override via OPENROUTER_MODEL / GEMINI_MODEL). */
  model: string;
  /** Where the user obtains their own API key. */
  keyHelpUrl: string;
  keyHelpText: string;
  keyFormatHint: string;
}

const PROVIDER_HELP: Record<ProviderId, { label: string; keyHelpUrl: string; keyHelpText: string; keyFormatHint: string }> = {
  openrouter: {
    label: "OpenRouter",
    keyHelpUrl: "https://openrouter.ai/keys",
    keyHelpText: "Create a free account at openrouter.ai, then generate a key under Keys.",
    keyFormatHint: "sk-or-v1-…",
  },
  gemini: {
    label: "Google Gemini",
    keyHelpUrl: "https://aistudio.google.com/apikey",
    keyHelpText: "Use Google AI Studio (aistudio.google.com) → “Get API key”.",
    keyFormatHint: "AIza…",
  },
};

/**
 * Which providers this deployment supports for user-supplied keys.
 * Requires no AI credentials of its own — the list is static metadata plus
 * the configured default model names.
 */
export function supportedProviders(config: AIConfig): ProviderSupportInfo[] {
  return PROVIDER_IDS.map((id) => ({ id, model: config[id].model, ...PROVIDER_HELP[id] }));
}

/**
 * Creates a provider adapter bound to ONE user's key for ONE request.
 *
 * Strict BYOK rules enforced here by construction:
 *  - the key must be supplied (never read from process.env — there is no
 *    owner key to fall back to);
 *  - the returned instance is used for this request only and then dropped —
 *    it is never attached to process state, a module singleton, or a cache;
 *  - two concurrent requests therefore can never share a credential.
 */
export function createUserProvider(config: AIConfig, providerId: ProviderId, apiKey: string, appUrl: string | null, fetchImpl?: FetchLike): AIProvider {
  const key = apiKey.trim();
  if (key.length < 8 || key.length > 300) {
    throw new AIProviderError("not_configured", providerId, null, "Provide your own API key from the AI settings page.");
  }
  switch (providerId) {
    case "gemini":
      return new GeminiProvider({ apiKey: key, model: config.gemini.model, timeoutMs: config.timeoutMs, fetchImpl });
    case "openrouter":
      return new OpenRouterProvider({ apiKey: key, model: config.openrouter.model, timeoutMs: config.timeoutMs, appUrl, fetchImpl });
    default:
      throw new AIProviderError("bad_request", "openrouter", null, "Unsupported AI provider.");
  }
}

/** Fresh config read; kept here so request handlers stay dependency-injectable in tests. */
export interface ByokBlueprint {
  config: AIConfig;
  appUrl: string | null;
  makeProvider(providerId: ProviderId, apiKey: string): AIProvider;
}

export function bluePrintFor(cfg: { ai: AIConfig; appUrl: string | null }): ByokBlueprint {
  return {
    config: cfg.ai,
    appUrl: cfg.appUrl,
    makeProvider: (providerId, apiKey) => createUserProvider(cfg.ai, providerId, apiKey, cfg.appUrl),
  };
}
