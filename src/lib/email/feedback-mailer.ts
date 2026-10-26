import "server-only";

/**
 * Outbound feedback email provider.
 *
 * Abstraction so the delivery mechanism stays swappable; the only shipped
 * implementation reuses the established Mailjet SMTP contract (same
 * server-only environment variable names as scripts/email/smtp-config.mjs —
 * SMTP_HOST restricted for the runtime feedback sender to the allowlist in
 * ALLOWED_SMTP_HOSTS (Mailjet or Brevo CSP-controlled relays), SMTP_PORT
 * 587+STARTTLS / 465+TLS with matching SMTP_SECURE, SMTP_USER, SMTP_PASS,
 * EMAIL_FROM). No new dependencies:
 * nodemailer is already a project dependency.
 *
 * Hard rules honoured here:
 *  - the recipient is FIXED server-side (FEEDBACK_RECIPIENT) — callers never
 *    choose it, and no user input reaches the envelope;
 *  - success is only ever returned when the provider accepted the message;
 *  - provider responses, stack traces and credentials are discarded — only a
 *    safe failure code crosses the boundary;
 *  - connection/greeting/socket timeouts are bounded so a hung provider can
 *    never hang the request indefinitely.
 */
import nodemailer, { type Transporter } from "nodemailer";

export const FEEDBACK_RECIPIENT = "talhaimtiazworks@gmail.com";

/**
 * Approved outbound SMTP relays for the runtime feedback sender. Credentials are
 * only ever sent to one of these hosts — unknown hosts fail closed (no mailer).
 * Mailjet: in-v3.mailjet.com · Brevo: smtp-relay.brevo.com. Extend deliberately.
 */
export const ALLOWED_SMTP_HOSTS = ["in-v3.mailjet.com", "smtp-relay.brevo.com"] as const;

export type FeedbackSendResult =
  | { accepted: true; providerMessageId: string | null }
  | { accepted: false; code: string; uncertain: boolean; message: string };

export interface FeedbackMailMessage {
  subject: string;
  text: string;
  html: string;
  /** Sender's own account address — used only as Reply-To, never as the recipient. */
  replyTo: string | null;
}

export interface FeedbackMailer {
  readonly provider: "mailjet-smtp" | "brevo-smtp";
  send(message: FeedbackMailMessage): Promise<FeedbackSendResult>;
}

type Env = Record<string, string | undefined>;

/** Failure codes are stable strings safe to store/log; never raw provider output. */
function classifySmtpFailure(error: unknown): { code: string; uncertain: boolean; message: string } {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  const status = typeof (error as { responseCode?: unknown })?.responseCode === "number" ? (error as { responseCode: number }).responseCode : 0;
  if (code === "EAUTH" || status === 534 || status === 535)
    return { code: "smtp_authentication_failed", uncertain: false, message: "The email provider rejected the configured credentials." };
  if (code === "ETLS" || /^(?:CERT_|ERR_TLS_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT)/.test(code))
    return { code: "smtp_tls_failed", uncertain: false, message: "A secure connection to the email provider could not be established." };
  if (code === "EENVELOPE" || (status >= 400 && status < 600))
    return { code: "smtp_message_rejected", uncertain: false, message: "The email provider did not accept this message." };
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EDNS", "ENETUNREACH", "EHOSTUNREACH"].includes(code))
    return { code: "smtp_connection_failed", uncertain: false, message: "The email provider could not be reached." };
  // A timeout after message data leaves acceptance uncertain — the row is marked
  // so it is NEVER blindly re-sent (that is how duplicate emails happen).
  if (code === "ETIMEDOUT")
    return { code: "smtp_timeout", uncertain: true, message: "The provider attempt timed out; acceptance could not be confirmed." };
  const command = typeof (error as { command?: unknown })?.command === "string" ? (error as { command: string }).command : "";
  const beforeMessage = ["CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "AUTH LOGIN", "AUTH PLAIN"].includes(command);
  return {
    code: "smtp_unavailable",
    uncertain: !beforeMessage,
    message: beforeMessage ? "The email provider is temporarily unavailable; nothing was sent." : "The provider's response could not be confirmed.",
  };
}

export function createFeedbackMailer(env: Env = process.env, inject?: { createTransport?: (options: Record<string, unknown>) => Transporter }): FeedbackMailer | null {
  // mirror scripts/email/smtp-config.mjs: credentials are only ever sent to allowlisted relay hosts.
  const host = env.SMTP_HOST?.trim().toLowerCase() || "in-v3.mailjet.com";
  const port = Number(env.SMTP_PORT?.trim() || "587");
  const secure = (env.SMTP_SECURE?.trim() || "false") === "true";
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS ?? null;
  const from = env.EMAIL_FROM?.trim() ?? null;
  if (!(ALLOWED_SMTP_HOSTS as readonly string[]).includes(host) || !(port === 587 || port === 465) || port === 465 !== secure || !user || !pass || !from || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    return null; // not configured (or misconfigured) — the service layer reports email_not_configured honestly
  }
  const makeTransport = inject?.createTransport ?? ((options: Record<string, unknown>) => nodemailer.createTransport(options));
  return {
    // Cosmetic label only — the transport contract below is identical for every allowlisted host.
    provider: host === "smtp-relay.brevo.com" ? "brevo-smtp" : "mailjet-smtp",
    async send(message) {
      let transport: Transporter | undefined;
      try {
        transport = makeTransport({
          host, port, secure,
          auth: { user, pass },
          connectionTimeout: 8_000,
          greetingTimeout: 8_000,
          socketTimeout: 15_000,
        });
        const info = await transport.sendMail({
          from: { name: "SiteInsights Feedback", address: from },
          to: FEEDBACK_RECIPIENT,
          envelope: { from, to: [FEEDBACK_RECIPIENT] },
          replyTo: message.replyTo ?? undefined,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
        const accepted = Array.isArray(info.accepted) && info.accepted.some((a) => (typeof a === "string" ? a : a.address) === FEEDBACK_RECIPIENT);
        if (!accepted) {
          return { accepted: false, code: "smtp_message_rejected", uncertain: false, message: "The email provider did not accept this message." };
        }
        const anyInfo = info as Record<string, unknown>;
        const providerMessageId = typeof anyInfo.messageId === "string" && /^[\x21-\x7E]{1,200}$/.test(anyInfo.messageId) ? anyInfo.messageId : null;
        return { accepted: true, providerMessageId };
      } catch (error) {
        const f = classifySmtpFailure(error);
        return { accepted: false, ...f };
      } finally {
        try { transport?.close(); } catch { /* transport teardown is not reportable */ }
      }
    },
  };
}
