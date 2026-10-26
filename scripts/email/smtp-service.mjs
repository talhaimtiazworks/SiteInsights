/**
 * Node-only SMTP diagnostics using Nodemailer. Auth mail remains owned by
 * Supabase: never call sendTest from sign-up, reset, resend or email-change.
 * No public route, no retry loop, no token/message-content logging.
 */
import nodemailer from "nodemailer";
import { readMailjetSmtpConfig, smtpTransportOptions } from "./smtp-config.mjs";

function failure(code, message, delivery) {
  return { ok: false, accepted: false, code, message, delivery, automaticRetry: false };
}

/** Discard raw SMTP responses, stack traces, addresses and authentication data. */
export function safeSmtpFailure(error, operation) {
  const code = typeof error?.code === "string" ? error.code : "";
  const status = typeof error?.responseCode === "number" ? error.responseCode : 0;
  if (code === "EAUTH" || status === 534 || status === 535) return failure("smtp_authentication_failed", "Mailjet did not accept SMTP authentication. Check the API key / Secret Key pair and account activation privately; do not use an email address or account login password.", "not_sent");
  if (code === "ETLS" || /^(?:CERT_|ERR_TLS_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT)/.test(code)) return failure("smtp_tls_failed", "A secure SMTP connection could not be established. Check TLS settings and the server certificate; do not disable certificate validation.", "not_sent");
  if (code === "EENVELOPE" || (status >= 400 && status < 600)) return failure("smtp_message_rejected", "The SMTP server did not accept this message. Check Mailjet sender/domain verification, the recipient and account activation/sending limits before another manual attempt.", "not_accepted");
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EDNS", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) return failure("smtp_connection_failed", "The SMTP server could not be reached. Check network access and the configured host and port.", "not_sent");
  // A connection loss after DATA can occur after acceptance. Never auto-retry.
  const beforeMessage = operation === "verify" || ["CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "AUTH LOGIN", "AUTH PLAIN"].includes(error?.command);
  if (code === "ETIMEDOUT") return failure("smtp_timeout", beforeMessage ? "The SMTP connection timed out. No email was sent by this check." : "The SMTP attempt timed out; acceptance is unknown. Check the recipient inbox before another manual attempt.", beforeMessage ? "not_sent" : "unknown");
  return failure("smtp_unavailable", beforeMessage ? "SMTP is temporarily unavailable. No email was sent by this check." : "The SMTP attempt could not be confirmed. Check the inbox before another manual attempt; delivery may already have occurred.", beforeMessage ? "not_sent" : "unknown");
}

export function createSmtpService({ env = process.env, createTransport = (options) => nodemailer.createTransport(options), auditLog = () => {} } = {}) {
  const config = readMailjetSmtpConfig(env);
  const log = (operation, result) => {
    // Only controlled event fields: never raw errors, options, responses or message bodies.
    try { auditLog({ event: "smtp_diagnostic", operation, code: result.code, delivery: result.delivery, ok: result.ok }); } catch { /* logging cannot trigger another send */ }
  };
  async function run(operation) {
    let transport;
    let result;
    try {
      transport = createTransport(smtpTransportOptions(config));
      if (operation === "verify") {
        const verified = await transport.verify();
        result = verified
          ? { ok: true, accepted: false, code: "smtp_connection_verified", message: "SMTP connection and authentication verified. No email was sent; Mailjet sender approval, Supabase configuration and inbox delivery remain unverified.", delivery: "not_sent", automaticRetry: false }
          : failure("smtp_verification_failed", "The SMTP connection was not verified. No email was sent.", "not_sent");
      } else {
        const info = await transport.sendMail({
          from: { name: "SiteInsights", address: config.from },
          to: config.from, // A single explicit operator test, only to the operator-configured sender.
          envelope: { from: config.from, to: [config.from] },
          subject: "SiteInsights SMTP configuration test",
          text: "SiteInsights — AI-Powered Website Auditing\n\nThis is a manually requested SMTP configuration test. It contains no authentication link or credentials. Receiving it does not verify Supabase's separate SMTP configuration.\n\nFind website issues. Understand them. Fix them.\nA TalhaImtiazWorks Product\n",
          html: "<h1>SiteInsights SMTP configuration test</h1><p>This manually requested test contains no authentication link or credentials. It does not verify Supabase's separate SMTP configuration.</p><p>Find website issues. Understand them. Fix them.</p><p>A TalhaImtiazWorks Product</p>",
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        const accepted = (info?.accepted ?? []).some((entry) => (typeof entry === "string" ? entry : entry?.address)?.toLowerCase() === config.from.toLowerCase());
        const rejected = (info?.rejected ?? []).some((entry) => (typeof entry === "string" ? entry : entry?.address)?.toLowerCase() === config.from.toLowerCase());
        result = accepted && !rejected
          ? { ok: true, accepted: true, code: "smtp_message_accepted", message: "The SMTP server accepted the test message. Check the inbox/spam folder; inbox delivery and Supabase auth mail are not yet verified.", delivery: "accepted_by_smtp", automaticRetry: false }
          : failure("smtp_message_not_accepted", "The SMTP server did not confirm acceptance of the test recipient. No delivery success is claimed.", "not_accepted");
      }
    } catch (error) {
      result = safeSmtpFailure(error, operation);
    } finally {
      try { transport?.close?.(); } catch { /* Never mask the actual result or resend. */ }
    }
    log(operation, result);
    return result;
  }
  return Object.freeze({ verify: () => run("verify"), sendTest: () => run("send-test") });
}
