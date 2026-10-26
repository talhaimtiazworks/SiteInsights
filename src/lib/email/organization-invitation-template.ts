export interface OrganizationInvitationEmailContent {
  recipientEmail: string;
  organizationName: string;
  inviterName: string;
  inviterEmail: string | null;
  role: "admin" | "member";
  expiresAt: string;
  invitationUrl: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]!);
}

/** Branded, text-first message. Every user-controlled value is escaped. */
export function renderOrganizationInvitationEmail(input: OrganizationInvitationEmailContent) {
  const team = escapeHtml(input.organizationName);
  const recipient = escapeHtml(input.recipientEmail);
  const inviter = escapeHtml(input.inviterName);
  const inviterEmail = input.inviterEmail ? ` (${escapeHtml(input.inviterEmail)})` : "";
  const role = input.role === "admin" ? "Admin" : "Member";
  const expiresAt = escapeHtml(input.expiresAt);
  const url = escapeHtml(input.invitationUrl);
  const text = [
    "SiteInsights",
    "A TalhaImtiazWorks Product",
    "",
    `You've been invited to join ${input.organizationName} as a ${role}.`,
    `Invited email: ${input.recipientEmail}`,
    `Invited by: ${input.inviterName}${input.inviterEmail ? ` (${input.inviterEmail})` : ""}`,
    `This invitation expires: ${input.expiresAt}`,
    "",
    "Review the details and choose Accept or Decline:",
    input.invitationUrl,
    "",
    "No team membership or audit access is granted unless you explicitly accept after signing in with the invited email address.",
    "If you weren't expecting this invitation, ignore this email. SiteInsights will never ask for your password by email.",
    "",
    "Find website issues. Understand them. Fix them.",
  ].join("\n");
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>Team invitation to SiteInsights</title></head>
<body style="margin:0;padding:0;background:#F5F7F9;color:#1B2631;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7F9;">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;">
        <tr><td style="padding:0 8px 18px;font-size:20px;font-weight:700;">SiteInsights <span style="font-size:12px;font-weight:500;color:#56636F;">by TalhaImtiazWorks</span></td></tr>
        <tr><td style="background:#FFFFFF;border:1px solid #D9E0E6;border-radius:14px;overflow:hidden;">
          <div style="height:4px;background:#0E436B;"></div>
          <div style="padding:30px 32px 24px;">
            <h1 style="margin:0 0 14px;font-size:24px;line-height:1.3;">You're invited to a team</h1>
            <p style="margin:0 0 18px;font-size:16px;line-height:1.6;color:#3D4A57;"><strong>${inviter}</strong>${inviterEmail} invited <strong>${recipient}</strong> to join <strong>${team}</strong> as a <strong>${role}</strong>.</p>
            <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#56636F;">Invitation expires: <strong>${expiresAt}</strong></p>
            <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#3D4A57;">Review the invitation details, then explicitly accept or decline after signing in with the invited email address. No team membership or audit access is granted before you accept.</p>
            <p style="margin:0 0 24px;"><a href="${url}" style="display:inline-block;background:#0E436B;color:#FFFFFF;text-decoration:none;padding:13px 22px;border-radius:9px;font-weight:600;">Review invitation</a></p>
            <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#56636F;">If the button doesn't work, copy this link into your browser:</p>
            <p style="margin:0 0 22px;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${url}" style="color:#0E436B;">${url}</a></p>
            <div style="padding:13px 15px;background:#F5F7F9;border:1px solid #D9E0E6;border-radius:9px;font-size:13px;line-height:1.55;color:#56636F;"><strong style="color:#3D4A57;">Security note:</strong> If you weren't expecting this invitation, ignore this email. SiteInsights will never ask for your password by email.</div>
          </div>
        </td></tr>
        <tr><td align="center" style="padding:20px 8px 0;font-size:12px;line-height:1.6;color:#56636F;">SiteInsights · AI-Powered Website Auditing<br>A TalhaImtiazWorks Product<br>Find website issues. Understand them. Fix them.</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject: `You're invited to ${input.organizationName} on SiteInsights`, text, html };
}
