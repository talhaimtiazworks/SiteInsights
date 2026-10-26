/**
 * Supabase settings, read from the environment. Kept free of "server-only" and
 * Node-only imports so proxy.ts can use it.
 *
 * Accepted names (first one set wins). These are the names Supabase documents
 * and that the Supabase ↔ Vercel integration creates:
 *   URL:          NEXT_PUBLIC_SUPABASE_URL, SUPABASE_URL
 *   Public key:   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_PUBLISHABLE_KEY,
 *                 NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_ANON_KEY   (legacy anon key)
 *   Secret key:   SUPABASE_SECRET_KEY, SUPABASE_SERVICE_ROLE_KEY     (server only, never sent to browsers)
 *
 * The secret key is only needed for account deletion (Auth admin API).
 */
type Env = Record<string, string | undefined>;

export interface SupabaseEnv {
  url: string | null;
  publishableKey: string | null;
  secretKey: string | null;
  /** Names of the variables actually used (for diagnostics; never values). */
  sources: { url: string | null; publishableKey: string | null; secretKey: string | null };
  /** True when sign-in can work (URL + public key present and the URL is valid). */
  authEnabled: boolean;
  warnings: string[];
}

function first(env: Env, names: string[]): { value: string | null; name: string | null } {
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return { value: v, name: n };
  }
  return { value: null, name: null };
}

export function readSupabaseEnv(env: Env = process.env): SupabaseEnv {
  const warnings: string[] = [];
  const url = first(env, ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]);
  const pub = first(env, ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"]);
  const secret = first(env, ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);
  let cleanUrl: string | null = null;
  if (url.value) {
    try {
      const u = new URL(url.value);
      if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) warnings.push(`${url.name} must use https.`);
      else cleanUrl = u.origin;
    } catch {
      warnings.push(`${url.name} is not a valid URL.`);
    }
  }
  if (cleanUrl && !pub.value) warnings.push("A Supabase URL is set but no publishable (anon) key: sign-in is disabled. Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  if (!cleanUrl && pub.value) warnings.push("A Supabase publishable key is set but no project URL: sign-in is disabled. Set NEXT_PUBLIC_SUPABASE_URL.");
  if (pub.value && /^sb_secret_/.test(pub.value)) {
    warnings.push(`${pub.name} contains a SECRET key. Use the publishable key there; secret keys must never be public.`);
    return { url: cleanUrl, publishableKey: null, secretKey: secret.value, sources: { url: url.name, publishableKey: null, secretKey: secret.name }, authEnabled: false, warnings };
  }
  if (secret.value && /^NEXT_PUBLIC_/.test(secret.name ?? "")) warnings.push("The Supabase secret key must not use a NEXT_PUBLIC_ name.");
  return {
    url: cleanUrl,
    publishableKey: pub.value,
    secretKey: secret.value,
    sources: { url: url.name, publishableKey: pub.name, secretKey: secret.name },
    authEnabled: !!cleanUrl && !!pub.value,
    warnings,
  };
}
