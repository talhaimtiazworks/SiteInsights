#!/usr/bin/env node
/**
 * Generates the branded Supabase Auth email templates (HTML + plain text) from
 * one layout, so every email looks the same and links to the production site.
 *
 *   node scripts/email/build-templates.mjs [--app-url https://siteinsight.xyz] [--year 2026] [--out dir]
 *
 * App URL: --app-url, else NEXT_PUBLIC_APP_URL, else Supabase's {{ .SiteURL }}
 * (which only works once Site URL is set correctly in Supabase). The result is
 * written to supabase/templates/*.html, supabase/templates/text/*.txt and
 * supabase/templates/subjects.json.
 *
 * Links go to the app's /auth/confirm page with {{ .TokenHash }}: the token is
 * verified only when the person clicks "Continue" there, so email security
 * scanners that pre-open links can't use it up, and the session is created on
 * the server (works when the link is opened in a different browser).
 *
 * Committed templates use {{ .SiteURL }} so existing deployments keep working.
 * Use --app-url for a verified deployment only; siteinsight.xyz is intended,
 * not confirmed live. No credentials or invented contact details are embedded.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
// --out lets tests render a local copy (e.g. for http://127.0.0.1:3000) without touching the committed templates.
const outDir = path.resolve(arg("--out") ?? path.join(root, "supabase/templates"));
const argUrl = arg("--app-url");
const rawUrl = argUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? null;
const YEAR = Number(arg("--year") ?? new Date().getFullYear());
if (!Number.isInteger(YEAR) || YEAR < 2000 || YEAR > 9999) throw new Error("--year must be a four-digit year");
const COPYRIGHT = `© ${YEAR} TalhaImtiazWorks. SiteInsights is a TalhaImtiazWorks product.`;
let APP = "{{ .SiteURL }}";
let DISPLAY = "{{ .SiteURL }}";
if (rawUrl && rawUrl !== "{{ .SiteURL }}") {
  const u = new URL(rawUrl);
  if (u.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) throw new Error("--app-url must be https://");
  APP = u.origin;
  DISPLAY = u.host;
}

// Brand (public/brand/README.md)
const palette = JSON.parse(await readFile(path.join(root, "src/lib/design-tokens.json"), "utf8")).colors;
const C = { primary: palette.primary, primaryDark: palette.primary, cyan: palette.accent, ink: palette.text, body: palette.secondary, muted: palette.muted, line: palette.border, bg: palette.ivory, card: palette.white, soft: palette.champagne };
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Inter, Helvetica, Arial, sans-serif";

const confirmLink = (type) => `${APP}/auth/confirm?token_hash={{ .TokenHash }}&type=${type}&next={{ .RedirectTo }}`;

/**
 * Each template: Supabase key, subject, preheader, heading, paragraphs, optional
 * button (label + link), optional code (OTP), security note.
 */
const TEMPLATES = [
  {
    key: "confirmation",
    subject: "Confirm your email for SiteInsights",
    preheader: "One click to activate your SiteInsights account.",
    heading: "Confirm your email address",
    intro: ["Welcome to SiteInsights! Confirm that this is your email address to activate your account and start auditing websites."],
    button: { label: "Confirm email address", href: confirmLink("email") },
    note: "If you didn't create a SiteInsights account, you can safely ignore this email — no account will be activated.",
  },
  {
    key: "recovery",
    subject: "Reset your SiteInsights password",
    preheader: "Choose a new password for your SiteInsights account.",
    heading: "Reset your password",
    intro: ["We received a request to reset the password for your SiteInsights account ({{ .Email }}). Continue to choose a new one."],
    button: { label: "Choose a new password", href: confirmLink("recovery") },
    note: "If you didn't ask to reset your password, ignore this email — your password stays the same. Never share this link.",
  },
  {
    key: "email_change",
    subject: "Confirm your new SiteInsights email address",
    preheader: "Confirm the change of your sign-in email.",
    heading: "Confirm your email change",
    intro: ["Someone (hopefully you) asked to change the email address of a SiteInsights account from {{ .Email }} to {{ .NewEmail }}.", "Confirm to complete the change. Depending on your security settings, a confirmation may also be sent to the other address."],
    button: { label: "Confirm email change", href: confirmLink("email_change") },
    note: "If you didn't request this change, don't click the button and reset your password right away.",
  },
  {
    key: "magic_link",
    subject: "Your SiteInsights sign-in link",
    preheader: "Sign in to SiteInsights with one click.",
    heading: "Sign in to SiteInsights",
    intro: ["Use the button below to sign in. The link expires shortly and can only be used once."],
    button: { label: "Sign in", href: confirmLink("magiclink") },
    code: "{{ .Token }}",
    codeLabel: "Or enter this one-time code:",
    note: "If you didn't try to sign in, you can ignore this email.",
  },
  {
    key: "invite",
    subject: "You've been invited to SiteInsights",
    preheader: "Accept your invitation to SiteInsights.",
    heading: "You're invited",
    intro: ["You've been invited to create a SiteInsights account for {{ .Email }}. Accept the invitation to set up your account."],
    button: { label: "Accept invitation", href: confirmLink("invite") },
    note: "If you weren't expecting this invitation, you can ignore this email.",
  },
  {
    key: "reauthentication",
    subject: "Your SiteInsights verification code",
    preheader: "Confirm it's you with this one-time code.",
    heading: "Confirm it's you",
    intro: ["Enter this code in SiteInsights to confirm a sensitive change to your account. It expires shortly."],
    code: "{{ .Token }}",
    note: "If you didn't request this code, someone may know your password — change it now.",
  },
  {
    key: "password_changed_notification",
    subject: "Your SiteInsights password was changed",
    preheader: "A security notice about your account.",
    heading: "Your password was changed",
    intro: ["The password for your SiteInsights account ({{ .Email }}) was just changed."],
    button: { label: "Review account security", href: `${APP}/account/security` },
    note: "If you didn't make this change, reset your password immediately from the sign-in page.",
  },
  {
    key: "email_changed_notification",
    subject: "Your SiteInsights email address was changed",
    preheader: "A security notice about your account.",
    heading: "Your email address was changed",
    intro: ["The email address for your SiteInsights account was changed from {{ .OldEmail }} to {{ .Email }}."],
    note: "If you didn't make this change, reset your password and review your connected sign-in methods.",
  },
  {
    key: "identity_linked_notification",
    subject: "A sign-in method was connected to SiteInsights",
    preheader: "A security notice about your account.",
    heading: "New sign-in method connected",
    intro: ["Your {{ .Provider }} account can now be used to sign in to SiteInsights as {{ .Email }}."],
    button: { label: "Manage sign-in methods", href: `${APP}/account/connections` },
    note: "If you didn't connect this sign-in method, remove it from your account and change your password.",
  },
  {
    key: "identity_unlinked_notification",
    subject: "A sign-in method was removed from SiteInsights",
    preheader: "A security notice about your account.",
    heading: "Sign-in method removed",
    intro: ["Your {{ .Provider }} account can no longer be used to sign in to SiteInsights as {{ .Email }}."],
    button: { label: "Manage sign-in methods", href: `${APP}/account/connections` },
    note: "If you didn't make this change, review your account security right away.",
  },
];

const esc = (s) => s; // copy is authored here; Go template actions must stay intact

function html(t) {
  const p = (s, extra = "") => `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:${C.body};${extra}">${esc(s)}</p>`;
  const button = t.button
    ? `
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
                <tr>
                  <td align="center" bgcolor="${C.primary}" style="border-radius:10px;background:${C.primary};">
                    <a href="${t.button.href}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;font-weight:600;line-height:1.2;color:#FFFFFF;text-decoration:none;border-radius:10px;border:1px solid ${C.primaryDark};">${t.button.label}</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 6px;font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};">Button not working? Copy and paste this link into your browser:</p>
              <p style="margin:0 0 24px;font-family:${FONT};font-size:13px;line-height:1.5;word-break:break-all;"><a href="${t.button.href}" target="_blank" style="color:${C.primary};text-decoration:underline;">${t.button.href}</a></p>`
    : "";
  const code = t.code
    ? `
              ${t.codeLabel ? `<p style="margin:0 0 8px;font-family:${FONT};font-size:14px;line-height:1.5;color:${C.muted};">${t.codeLabel}</p>` : ""}
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                <tr><td style="background:${C.soft};border:1px solid ${C.line};border-radius:10px;padding:14px 22px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:28px;font-weight:700;letter-spacing:6px;color:${C.ink};">${t.code}</td></tr>
              </table>`
    : "";
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${t.subject}</title>
<style>
  @media only screen and (max-width: 600px) {
    .si-container { width: 100% !important; }
    .si-pad { padding-left: 22px !important; padding-right: 22px !important; }
    .si-h1 { font-size: 22px !important; }
  }
  a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; }
</style>
</head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${t.preheader}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="background:${C.bg};">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" class="si-container" width="560" border="0" cellpadding="0" cellspacing="0" style="width:560px;max-width:560px;">
          <tr>
            <td class="si-pad" style="padding:0 8px 20px;">
              <a href="${APP}" target="_blank" style="text-decoration:none;">
                <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding-right:10px;vertical-align:middle;"><img src="${APP}/brand/talhaimtiazworks-logo-160.png" width="64" height="64" alt="SiteInsights by TalhaImtiazWorks" style="display:block;border:0;width:64px;height:64px;"></td>
                    <td style="vertical-align:middle;font-family:${FONT};font-size:20px;font-weight:700;letter-spacing:-0.2px;color:${C.ink};">SiteInsights<br><span style="font-size:11px;font-weight:500;letter-spacing:0;color:${C.muted};">by TalhaImtiazWorks</span></td>
                  </tr>
                </table>
              </a>
            </td>
          </tr>
          <tr>
            <td style="background:${C.card};border:1px solid ${C.line};border-radius:16px;overflow:hidden;">
              <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
                <tr><td style="height:4px;line-height:4px;font-size:0;background:${C.primary};">&nbsp;</td></tr>
                <tr>
                  <td class="si-pad" style="padding:36px 40px 12px;">
                    <h1 class="si-h1" style="margin:0 0 16px;font-family:${FONT};font-size:24px;line-height:1.3;font-weight:700;color:${C.ink};">${t.heading}</h1>
                    ${t.intro.map((s) => p(s)).join("\n                    ")}${button}${code}
                  </td>
                </tr>
                <tr>
                  <td class="si-pad" style="padding:0 40px 32px;">
                    <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
                      <tr><td style="background:${C.bg};border:1px solid ${C.line};border-radius:10px;padding:14px 16px;font-family:${FONT};font-size:13px;line-height:1.55;color:${C.muted};"><strong style="color:${C.body};">Security note:</strong> ${t.note} SiteInsights will never ask for your password by email.</td></tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="si-pad" align="center" style="padding:24px 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};">
              <strong style="color:${C.body};">SiteInsights</strong> · AI-Powered Website Auditing<br>
              A <strong>TalhaImtiazWorks</strong> Product<br>
              Find website issues. Understand them. Fix them.<br>
              ${COPYRIGHT}<br>
              <a href="${APP}" target="_blank" style="color:${C.muted};text-decoration:underline;">${DISPLAY}</a><br>
              You received this email because of an action on your SiteInsights account.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

function text(t) {
  const lines = ["SiteInsights", "", t.heading.toUpperCase(), "", ...t.intro.flatMap((s) => [s, ""])];
  if (t.button) lines.push(`${t.button.label}:`, t.button.href, "");
  if (t.code) lines.push(t.codeLabel ?? "Your code:", t.code, "");
  lines.push(`Security note: ${t.note} SiteInsights will never ask for your password by email.`, "", "—", "SiteInsights · AI-Powered Website Auditing", "A TalhaImtiazWorks Product", "Find website issues. Understand them. Fix them.", COPYRIGHT, APP, "You received this email because of an action on your SiteInsights account.", "");
  return lines.join("\n");
}

await mkdir(path.join(outDir, "text"), { recursive: true });
const subjects = {};
for (const t of TEMPLATES) {
  // Non-ASCII characters (—, ·, ’) as numeric entities: renders correctly even if a relay or client mangles the charset.
  await writeFile(path.join(outDir, `${t.key}.html`), html(t).replace(/[^\x00-\x7F]/gu, (c) => `&#${c.codePointAt(0)};`));
  await writeFile(path.join(outDir, "text", `${t.key}.txt`), text(t));
  subjects[t.key] = t.subject;
}
await writeFile(path.join(outDir, "subjects.json"), JSON.stringify({ appUrl: APP, year: YEAR, subjects }, null, 2) + "\n");
console.log(`Wrote ${TEMPLATES.length} templates for ${APP} to ${path.relative(root, outDir)}/`);
