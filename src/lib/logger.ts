import "server-only";

/**
 * Minimal server logger that redacts anything resembling a credential before
 * writing to stdout/stderr. Never log request headers or raw config objects.
 */
type Rule = [RegExp, string];
const RULES: Rule[] = [
  [/smtps?:\/\/[^\s"'<>]+/gi, "[REDACTED]"], // SMTP URLs may contain both user and password
  [/\b((?:mailjet[ _-]?)?(?:api[ _-]?key|secret[ _-]?key)|mj_apikey_(?:public|private))(["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi, "$1$2[REDACTED]"], // API key is also private for SMTP, even when a provider calls it public
  [/\b(smtp_pass(?:word)?|app[ _-]?password)(["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|(?:[A-Za-z0-9]{4}[ \u00a0]){3}[A-Za-z0-9]{4}|[^\s,;}\n]+)/gi, "$1$2[REDACTED]"], // also redact grouped legacy credential displays
  [/\b(smtp_user|email_from|supabase_access_token)(["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}\n]+)/gi, "$1$2[REDACTED]"],
  [/sk-or-[A-Za-z0-9_\-]{8,}/g, "[REDACTED]"], // OpenRouter keys
  [/AIza[0-9A-Za-z_\-]{20,}/g, "[REDACTED]"], // Google API keys
  [/sb_(?:secret|publishable)_[A-Za-z0-9_\-]{8,}/g, "[REDACTED]"], // Supabase API keys
  [/eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, "[REDACTED]"], // JWTs (access tokens, legacy anon/service_role keys)
  [/Bearer\s+[A-Za-z0-9._\-~+/=]{8,}/gi, "Bearer [REDACTED]"],
  [/\b(sb-[A-Za-z0-9-]+-auth-token(?:-code-verifier)?(?:\.\d+)?)=[^;\s"',]+/g, "$1=[REDACTED]"], // Supabase session cookies
  [/([?&#](?:token_hash|token|code|access_token|refresh_token|code_verifier|provider_token|provider_refresh_token)=)[^&\s"'#]+/gi, "$1[REDACTED]"], // email-link / OAuth params
  [/\b((?:set-)?cookie["']?\s*[:=]\s*)[^\n]+/gi, "$1[REDACTED]"], // whole Cookie / Set-Cookie header values
  [/\b(x-goog-api-key|authorization|api[_-]?key|password|passwd|secret|access_token|refresh_token|token_hash|code_verifier|provider_token)(["'\s:=]+)[^\s"',}]+/gi, "$1$2[REDACTED]"],
  [/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED]"],
  [/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g, "$1***@$2"], // email addresses (personal data)
];

/** Removes credentials, session tokens and personal data from a log line. */
export function redact(input: string): string {
  let out = input;
  // Also remove known SMTP credentials if a third-party message omits a field name.
  // This is defense-in-depth; the SMTP service never logs raw provider messages.
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASS;
  const configured = [user, password, process.env.EMAIL_FROM]
    .filter((value): value is string => typeof value === "string" && value.length >= 4);
  const privateValues = new Set(configured.flatMap((value) => [value, encodeURIComponent(value), Buffer.from(value).toString("base64")]));
  if (user && password) {
    privateValues.add(Buffer.from(`${user}:${password}`).toString("base64"));
    privateValues.add(Buffer.from(`\0${user}\0${password}`).toString("base64"));
  }
  for (const value of [...privateValues].sort((a, b) => b.length - a.length)) out = out.split(value).join("[REDACTED]");
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

function fmt(err: unknown): string {
  if (err instanceof Error) return redact(`${err.name}: ${err.message}`);
  try {
    return redact(typeof err === "string" ? err : JSON.stringify(err));
  } catch {
    return "[unserialisable]";
  }
}

export const logger = {
  info(msg: string, extra?: unknown) {
    console.info(`[siteinsight] ${redact(msg)}${extra !== undefined ? " " + fmt(extra) : ""}`);
  },
  warn(msg: string, extra?: unknown) {
    console.warn(`[siteinsight] ${redact(msg)}${extra !== undefined ? " " + fmt(extra) : ""}`);
  },
  error(msg: string, extra?: unknown) {
    console.error(`[siteinsight] ${redact(msg)}${extra !== undefined ? " " + fmt(extra) : ""}`);
  },
};
