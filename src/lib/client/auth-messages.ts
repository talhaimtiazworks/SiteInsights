/** Messages for ?error= codes set by /auth/callback and protected pages. */
export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Sign-in was cancelled.",
  identity_already_exists: "That account is already connected to a different SiteInsights user.",
  email_not_confirmed: "Please confirm your email address first.",
  otp_expired: "This link is invalid or has expired. Request a new one.",
  link_invalid: "This link is invalid or has expired. Request a new one.",
  flow_state_expired: "The sign-in attempt took too long. Please try again.",
  bad_code_verifier: "Please finish signing in in the same browser you started in.",
  provider_disabled: "That sign-in method isn't enabled.",
  manual_linking_disabled: "Connecting additional sign-in methods isn't enabled for this project.",
  signup_disabled: "New sign-ups are currently disabled.",
  missing_code: "The sign-in link was incomplete. Please try again.",
  callback_failed: "We couldn't complete sign-in. Please try again.",
  server_error: "The sign-in provider reported an error. Please try again.",
};

export const authErrorMessage = (code: string | null | undefined) => (code ? AUTH_ERROR_MESSAGES[code] ?? AUTH_ERROR_MESSAGES.callback_failed : null);
