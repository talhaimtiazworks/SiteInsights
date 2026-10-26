import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { trustedProviderAvatarUrl } from "../avatar";

export type OAuthProvider = "google" | "github";
export type OAuthFlowMode = "sign_in" | "sign_up" | "link";
export type OAuthProviderState = { provider: OAuthProvider; mode: OAuthFlowMode; issuedAt: number };
export type SessionProviderMarker = { provider: OAuthProvider; avatarUrl: string | null };

export const OAUTH_PROVIDER_STATE_COOKIE = "si_oauth_provider_state";
export const SESSION_PROVIDER_COOKIE = "si_session_provider";
export const OAUTH_PROVIDER_STATE_TTL_SECONDS = 10 * 60;
export const SESSION_PROVIDER_COOKIE_TTL_SECONDS = 365 * 24 * 60 * 60;

const MIN_SECRET_BYTES = 32;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function hasStrongSecret(secret: string | null | undefined): secret is string {
  return typeof secret === "string" && Buffer.byteLength(secret, "utf8") >= MIN_SECRET_BYTES;
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function signatureMatches(value: string, payload: string, secret: string): boolean {
  if (!SIGNATURE_RE.test(value)) return false;
  const actual = Buffer.from(value, "base64url");
  const expected = Buffer.from(signature(payload, secret), "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A signed, short-lived marker bound to the provider and sign-in/link mode selected for this OAuth start. */
export function createOAuthProviderState(
  provider: OAuthProvider,
  secret: string | null,
  mode: OAuthFlowMode = "sign_in",
  now = Date.now(),
): string | null {
  if (!hasStrongSecret(secret)) return null;
  const issuedAt = Math.floor(now / 1000);
  const nonce = randomBytes(16).toString("base64url");
  const payload = `oauth.v1|${provider}|${mode}|${issuedAt}|${nonce}`;
  return `v1.${provider}.${mode}.${issuedAt}.${nonce}.${signature(payload, secret)}`;
}

/** Verify the marker returned through both the OAuth callback URL and HttpOnly cookie. */
export function verifyOAuthProviderState(value: string | null | undefined, secret: string | null, now = Date.now()): OAuthProviderState | null {
  if (!hasStrongSecret(secret) || typeof value !== "string" || value.length > 256) return null;
  const parts = value.split(".");
  if (parts.length !== 6 || parts[0] !== "v1") return null;
  const [, provider, mode, issuedText, nonce, sig] = parts;
  if ((provider !== "github" && provider !== "google") || (mode !== "sign_in" && mode !== "sign_up" && mode !== "link") || !/^\d{1,12}$/.test(issuedText) || !NONCE_RE.test(nonce)) return null;
  const issuedAt = Number(issuedText);
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > nowSeconds + 30 || nowSeconds - issuedAt > OAUTH_PROVIDER_STATE_TTL_SECONDS) return null;
  const payload = `oauth.v1|${provider}|${mode}|${issuedAt}|${nonce}`;
  return signatureMatches(sig, payload, secret) ? { provider, mode, issuedAt } : null;
}

/**
 * Sign the provider and provider-supplied avatar against the validated Supabase
 * session_id. The marker is HttpOnly and cannot be reused for another session.
 */
export function createSessionProviderMarker(
  provider: OAuthProvider,
  sessionId: string,
  avatarCandidate: unknown,
  secret: string | null,
): string | null {
  if (!hasStrongSecret(secret) || !SESSION_ID_RE.test(sessionId)) return null;
  const avatarUrl = provider === "github" ? trustedProviderAvatarUrl(provider, avatarCandidate) : null;
  const encodedAvatar = avatarUrl ? Buffer.from(avatarUrl, "utf8").toString("base64url") : "-";
  const payload = `session.v1|${provider}|${sessionId}|${encodedAvatar}`;
  return `v1.${provider}.${sessionId}.${encodedAvatar}.${signature(payload, secret)}`;
}

/** Read a signed marker only when it is bound to the verified JWT's session_id. */
export function readSessionProviderMarker(
  value: string | null | undefined,
  sessionId: string | null | undefined,
  secret: string | null,
): SessionProviderMarker | null {
  if (!hasStrongSecret(secret) || typeof value !== "string" || value.length > 4096 || typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return null;
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") return null;
  const [, provider, markerSessionId, encodedAvatar, sig] = parts;
  if ((provider !== "github" && provider !== "google") || markerSessionId !== sessionId) return null;
  const payload = `session.v1|${provider}|${markerSessionId}|${encodedAvatar}`;
  if (!signatureMatches(sig, payload, secret)) return null;

  let avatarUrl: string | null = null;
  if (encodedAvatar !== "-") {
    if (provider !== "github" || !/^[A-Za-z0-9_-]{1,3000}$/.test(encodedAvatar)) return null;
    const bytes = Buffer.from(encodedAvatar, "base64url");
    if (bytes.length > 2048 || bytes.toString("base64url") !== encodedAvatar) return null;
    avatarUrl = trustedProviderAvatarUrl(provider, bytes.toString("utf8"));
    if (!avatarUrl) return null;
  }
  return { provider, avatarUrl };
}

/** Identify the uniquely most recently used OAuth identity from Supabase's server-returned user record. */
export function latestOAuthIdentityProvider(identities: unknown): OAuthProvider | null {
  if (!Array.isArray(identities)) return null;
  const entries = identities.flatMap((identity) => {
    if (typeof identity !== "object" || identity === null || Array.isArray(identity)) return [];
    const record = identity as Record<string, unknown>;
    if ((record.provider !== "github" && record.provider !== "google") || typeof record.last_sign_in_at !== "string") return [];
    const timestamp = Date.parse(record.last_sign_in_at);
    return Number.isFinite(timestamp) ? [{ provider: record.provider, timestamp }] : [];
  });
  if (!entries.length) return null;
  const newest = Math.max(...entries.map((entry) => entry.timestamp));
  const latest = entries.filter((entry) => entry.timestamp === newest);
  return latest.length === 1 ? latest[0].provider as OAuthProvider : null;
}

export function providerCookieOptions(secure: boolean, maxAge: number) {
  return { httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge };
}
