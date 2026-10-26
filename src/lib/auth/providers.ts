import "server-only";
import { getConfig } from "../config/env";
import { logger } from "../logger";

export interface AuthProviders {
  enabled: boolean;
  email: boolean;
  google: boolean;
  github: boolean;
  /** SAML SSO is enabled on the Supabase project (Pro plan or above). Domains still need a configured identity provider. */
  saml: boolean;
  signupDisabled: boolean;
  /** The auth server could not be reached; provider buttons are hidden. */
  unavailable: boolean;
}

let cache: { at: number; value: AuthProviders } | null = null;
const TTL = 60_000;

/**
 * Which sign-in methods the Supabase project actually has enabled, read from
 * the public Auth settings endpoint (GET /auth/v1/settings). Buttons for
 * methods that aren't enabled are never shown.
 */
export async function getAuthProviders(fetchImpl: typeof fetch = fetch): Promise<AuthProviders> {
  const env = getConfig().auth.supabase;
  const off: AuthProviders = { enabled: false, email: false, google: false, github: false, saml: false, signupDisabled: true, unavailable: false };
  if (!env.authEnabled) return off;
  if (cache && Date.now() - cache.at < TTL) return cache.value;
  try {
    const res = await fetchImpl(`${env.url}/auth/v1/settings`, { headers: { apikey: env.publishableKey! }, signal: AbortSignal.timeout(5000), cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = (await res.json()) as { external?: Record<string, boolean>; disable_signup?: boolean; saml_enabled?: boolean };
    const value: AuthProviders = {
      enabled: true,
      email: !!s.external?.email,
      google: !!s.external?.google,
      github: !!s.external?.github,
      saml: !!s.saml_enabled,
      signupDisabled: !!s.disable_signup,
      unavailable: false,
    };
    cache = { at: Date.now(), value };
    return value;
  } catch (err) {
    logger.warn("Could not read Supabase Auth settings", err instanceof Error ? err.message : "unknown");
    // Email/password is the baseline; OAuth buttons stay hidden until the settings can be read.
    return { ...off, enabled: true, email: true, signupDisabled: false, unavailable: true };
  }
}

export function __resetAuthProvidersCache() {
  cache = null;
}
