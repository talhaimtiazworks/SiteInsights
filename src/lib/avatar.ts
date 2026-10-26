const GITHUB_AVATAR_HOST = "avatars.githubusercontent.com";
const MAX_AVATAR_URL_LENGTH = 2048;

/**
 * Accept only the HTTPS GitHub avatar endpoint for a GitHub OAuth session.
 * This intentionally rejects arbitrary HTTPS URLs, other provider images,
 * userinfo/ports/fragments, and non-avatar paths on the GitHub host.
 */
export function trustedProviderAvatarUrl(provider: string | null | undefined, candidate: unknown): string | null {
  if (provider?.trim().toLowerCase() !== "github" || typeof candidate !== "string") return null;
  const value = candidate.trim();
  if (!value || value.length > MAX_AVATAR_URL_LENGTH) return null;

  try {
    const authority = value.match(/^https:\/\/([^/?#]*)/i)?.[1];
    const url = new URL(value);
    if (
      !authority ||
      authority.toLowerCase() !== GITHUB_AVATAR_HOST ||
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== GITHUB_AVATAR_HOST ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !/^\/u\/\d+\/?$/.test(url.pathname)
    ) return null;

    for (const [name, parameter] of url.searchParams) {
      if ((name !== "v" && name !== "s") || !/^\d{1,5}$/.test(parameter)) return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

/** Return an avatar only from the provider identity object returned by Supabase Auth's server API. */
export function trustedGithubIdentityAvatar(identity: unknown): string | null {
  if (typeof identity !== "object" || identity === null || Array.isArray(identity)) return null;
  const record = identity as Record<string, unknown>;
  if (record.provider !== "github" || typeof record.identity_data !== "object" || record.identity_data === null || Array.isArray(record.identity_data)) return null;
  return trustedProviderAvatarUrl("github", (record.identity_data as Record<string, unknown>).avatar_url);
}

/** Defense in depth for every browser image: only a validated GitHub avatar URL may load. */
export function isTrustedGithubAvatarUrl(candidate: unknown): candidate is string {
  return trustedProviderAvatarUrl("github", candidate) !== null;
}
