import "server-only";

/**
 * Outbound team invitation email is intentionally not configured. The existing
 * Mailjet/Nodemailer transport is reserved for operator diagnostics, not app
 * runtime delivery. Invitation records and the authenticated recipient inbox
 * remain available; callers must never claim that an email was sent.
 */
export type InvitationEmailDelivery = {
  status: "not_configured";
  errorCode: "email_not_configured" | "delivery_status_unavailable";
  message: string;
};

export const ORGANIZATION_INVITATION_EMAIL_NOT_CONFIGURED: InvitationEmailDelivery = Object.freeze({
  status: "not_configured",
  errorCode: "email_not_configured",
  message: "The invitation is saved, but team email is not configured. The recipient can accept or decline it from the Invitation inbox in Teams.",
});
