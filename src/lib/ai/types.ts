import type { ProviderId } from "../config/env";

export type { ProviderId };

export interface AIGenerateRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  temperature?: number;
  /** Ask the provider for a JSON object response where supported. */
  json?: boolean;
}

export interface AIGenerateResult {
  text: string;
  provider: ProviderId;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ProviderHealth {
  provider: ProviderId;
  ok: boolean;
  code: string;
  message: string;
  latencyMs: number | null;
  checkedAt: string;
}

/**
 * An adapter bound to exactly one user's key (constructed per request — see
 * registry.ts `createUserProvider`). There is deliberately no `isConfigured`/
 * `configured` concept: without a supplied key no instance can even exist.
 */
export interface AIProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly model: string;
  generate(req: AIGenerateRequest, signal?: AbortSignal): Promise<AIGenerateResult>;
  /** Verifies credentials/model without generating tokens where the API allows. */
  healthCheck(): Promise<ProviderHealth>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
