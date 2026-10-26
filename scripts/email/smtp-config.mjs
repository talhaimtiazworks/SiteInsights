/**
 * Operator/server-only Mailjet configuration. Never import this from client code.
 * Hosted authentication mail is sent by Supabase Auth, NOT this Node process.
 * No environment is read until an explicit call; importing/building sends nothing.
 */
export class SmtpConfigurationError extends Error {
  constructor(message, variables) {
    super(message);
    this.name = "SmtpConfigurationError";
    this.code = "smtp_configuration_invalid";
    this.variables = variables;
  }
}

const invalid = (message, variables) => { throw new SmtpConfigurationError(message, variables); };
const mailbox = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
function address(value, variable) {
  const s = (value ?? "").trim();
  const [local, domain = ""] = s.split("@");
  if (!s || s.length > 254 || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") || domain.split(".").some((part) => part.length > 63) || /[\r\n]/.test(value ?? "") || /[\s<>;,]/.test(s) || !mailbox.test(s)) {
    invalid(`${variable} must be one bare email address (no display name, list or header characters).`, [variable]);
  }
  return s; // Preserve the configured sender's local-part case; never derive it from an API key.
}

function credential(value, variable, label) {
  // Deliberately do not guess an exact provider key length/hex format, lowercase,
  // trim or remove spaces. This is a local safety policy, NOT live validation.
  if (typeof value !== "string" || value.length < 16 || value.length > 256 || /[^\x21-\x7e]/.test(value)) {
    invalid(`${variable} must contain the Mailjet ${label}: 16–256 printable ASCII characters, without spaces or control characters. Copy the issued value exactly; account passwords are not SMTP credentials.`, [variable]);
  }
  return value;
}

export function readMailjetSmtpConfig(env = process.env) {
  if (typeof window !== "undefined") invalid("SMTP configuration is server-only.", []);
  const exposed = Object.keys(env).some((name) => /^NEXT_PUBLIC_(?:SMTP_|MAILJET_|MJ_APIKEY_|EMAIL_FROM$)/.test(name));
  if (exposed) invalid("Remove public SMTP/Mailjet environment variables; use only the established server-only names.", ["NEXT_PUBLIC_SMTP_*", "NEXT_PUBLIC_MAILJET_*", "NEXT_PUBLIC_MJ_APIKEY_*", "NEXT_PUBLIC_EMAIL_FROM"]);

  const host = env.SMTP_HOST?.trim().toLowerCase() || "in-v3.mailjet.com";
  if (host !== "in-v3.mailjet.com") invalid("This Mailjet adapter requires SMTP_HOST=in-v3.mailjet.com; credentials are never sent to an arbitrary host.", ["SMTP_HOST"]);
  const rawPort = env.SMTP_PORT?.trim() || "587";
  if (!/^(465|587)$/.test(rawPort)) invalid("SMTP_PORT must be 587 (required STARTTLS) or 465 (implicit TLS).", ["SMTP_PORT"]);
  const rawSecure = env.SMTP_SECURE?.trim() || "false";
  if (rawSecure !== "true" && rawSecure !== "false") invalid("SMTP_SECURE must be exactly true or false.", ["SMTP_SECURE"]);
  const port = Number(rawPort);
  const secure = rawSecure === "true";
  if ((port === 465 && !secure) || (port === 587 && secure)) invalid("Use SMTP_PORT=587 with SMTP_SECURE=false and required STARTTLS, or SMTP_PORT=465 with SMTP_SECURE=true.", ["SMTP_PORT", "SMTP_SECURE"]);

  const missing = ["SMTP_USER", "SMTP_PASS", "EMAIL_FROM"].filter((name) => !env[name]?.trim());
  if (missing.length) invalid(`Missing server-side email settings: ${missing.join(", ")}.`, missing);
  const user = credential(env.SMTP_USER, "SMTP_USER", "API key");
  if (user.includes("@")) invalid("SMTP_USER must be the Mailjet API key, not an email address or the Mailjet account login.", ["SMTP_USER"]);
  const password = credential(env.SMTP_PASS, "SMTP_PASS", "Secret Key");
  const from = address(env.EMAIL_FROM, "EMAIL_FROM");
  // Sender verification/domain ownership belongs to Mailjet. Syntax is checked
  // offline; neither possession of credentials nor mailbox syntax proves approval.
  // EMAIL_FROM is independent of SMTP_USER, which is an opaque API key, not email.
  const config = { host, port, secure };
  Object.defineProperties(config, {
    user: { value: user, enumerable: false },
    password: { value: password, enumerable: false },
    from: { value: from, enumerable: false },
  });
  return Object.freeze(config);
}

/** Supabase exposes no smtp_secure API field: its SMTP implementation uses the port. */
export function mailjetSmtpPatch(env = process.env) {
  const config = readMailjetSmtpConfig(env);
  return {
    smtp_host: config.host,
    smtp_port: String(config.port),
    smtp_user: config.user,
    smtp_pass: config.password,
    smtp_admin_email: config.from,
    smtp_sender_name: "SiteInsights",
  };
}

export function smtpTransportOptions(config) {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    ignoreTLS: false,
    opportunisticTLS: false,
    auth: { user: config.user, pass: config.password },
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true, servername: config.host },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    dnsTimeout: 10_000,
    pool: false,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}
