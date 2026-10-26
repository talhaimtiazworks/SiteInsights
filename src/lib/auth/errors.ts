import "server-only";
import { ApiError } from "../http/api";
import { logger } from "../logger";

interface AuthErrorLike {
  name?: string;
  code?: string;
  status?: number;
  message?: string;
}

/**
 * Maps Supabase Auth errors to stable API errors with user-facing messages.
 * Raw provider messages are never forwarded verbatim (including password-policy errors).
 */
export function authError(err: unknown, context: string): ApiError {
  const e = (err ?? {}) as AuthErrorLike;
  const code = e.code ?? "";
  // These fields come from a provider: log only a bounded status, never arbitrary
  // codes/messages that could contain SMTP credentials or provider responses.
  const safeStatus = typeof e.status === "number" && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599 ? e.status : undefined;
  switch (code) {
    case "invalid_credentials":
      return new ApiError(401, "invalid_credentials", "Incorrect email or password.");
    case "email_not_confirmed":
      return new ApiError(403, "email_not_confirmed", "Please confirm your email address first. Check your inbox for the confirmation link, or send a new one.");
    case "user_already_exists":
    case "email_exists":
      return new ApiError(409, "email_in_use", "An account with this email already exists. Sign in instead, or reset your password.");
    case "weak_password":
      return new ApiError(400, "weak_password", "This password does not meet the account's security requirements. Use a longer password with a mix of letters, numbers and symbols.");
    case "same_password":
      return new ApiError(400, "same_password", "The new password must be different from your current password.");
    case "signup_disabled":
    case "email_provider_disabled":
      return new ApiError(403, "signup_disabled", "New sign-ups are currently disabled.");
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
    case "over_sms_send_rate_limit":
      return new ApiError(429, "auth_rate_limited", "Too many attempts. Please wait a few minutes and try again.");
    case "otp_expired":
    case "flow_state_expired":
    case "flow_state_not_found":
    case "bad_code_verifier":
      return new ApiError(400, "link_invalid", "This link is invalid or has expired. Request a new one.");
    case "session_not_found":
    case "refresh_token_not_found":
    case "refresh_token_already_used":
      return new ApiError(401, "session_expired", "Your session has expired. Please sign in again.");
    case "reauthentication_needed":
    case "reauthentication_not_valid":
      return new ApiError(403, "reauthentication_needed", "For security, please sign in again before changing your password.");
    case "sso_provider_not_found":
      return new ApiError(404, "sso_not_configured", "Single sign-on isn't set up for this email domain. Sign in with your password or another method.");
    case "saml_provider_disabled":
    case "sso_domain_already_exists":
      return new ApiError(404, "sso_not_configured", "Single sign-on isn't enabled for this project.");
    case "provider_disabled":
      return new ApiError(400, "provider_disabled", "This sign-in method isn't enabled.");
    case "manual_linking_disabled":
      return new ApiError(400, "linking_disabled", "Connecting additional sign-in methods isn't enabled for this project.");
    case "identity_already_exists":
      return new ApiError(409, "identity_in_use", "That account is already connected to a different SiteInsights user.");
    case "single_identity_not_deletable":
      return new ApiError(400, "last_identity", "You can't disconnect your only sign-in method.");
    case "email_address_not_authorized":
      // Supabase's built-in email sender only delivers to the project's team members.
      logger.error(`Supabase Auth refused to send email (${context}): the built-in email service only delivers to project team members. Configure custom SMTP in Supabase → Authentication → Emails → SMTP Settings.`);
      return new ApiError(503, "email_unavailable", "We can't send email to this address right now. Please try again later or contact the site owner.");
    case "email_address_invalid":
    case "validation_failed":
      return new ApiError(400, "invalid_email", "Please enter a valid email address.");
    case "user_banned":
      return new ApiError(403, "user_banned", "This account has been suspended.");
  }
  if (e.name === "AuthRetryableFetchError" || (typeof e.status === "number" && e.status >= 500)) {
    logger.error(`Supabase Auth unavailable (${context})`, { status: safeStatus, code: "provider_failure" });
    return new ApiError(503, "auth_unavailable", "Sign-in is temporarily unavailable. Please try again in a moment.");
  }
  if (e.status === 429) return new ApiError(429, "auth_rate_limited", "Too many attempts. Please wait a few minutes and try again.");
  logger.warn(`Unhandled Supabase Auth error (${context})`, { status: safeStatus, code: "unrecognized_auth_error" });
  return new ApiError(400, "auth_failed", "That didn't work. Please check your details and try again.");
}
