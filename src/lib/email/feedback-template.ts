/** Branded, text-first feedback digest. Every user-controlled value is escaped. */
import type { FeedbackCategory } from "../db/account-types";

export const FEEDBACK_CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  general: "General feedback",
  bug: "Bug report",
  feature: "Feature request",
  other: "Other",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

export interface FeedbackEmailContent {
  submissionId: string;
  category: FeedbackCategory;
  rating: number | null;
  message: string;
  goal: string | null;
  pageUrl: string | null;
  accountEmail: string | null;
  accountUserId: string;
  submittedAt: string; // ISO 8601
}

export function renderFeedbackEmail(input: FeedbackEmailContent) {
  const cat = FEEDBACK_CATEGORY_LABELS[input.category];
  const rating = input.rating === null ? "Not rated" : `${input.rating} / 5`;
  const text = [
    "SiteInsights — user feedback",
    "",
    `Category: ${cat}`,
    `Satisfaction: ${rating}`,
    `Account: ${input.accountEmail ?? "(email on file unavailable)"} (user ${input.accountUserId})`,
    `Submitted: ${input.submittedAt}`,
    `Submission id: ${input.submissionId}`,
    input.pageUrl ? `Page: ${input.pageUrl}` : null,
    "",
    "Message:",
    input.message,
    input.goal ? `\nThey were trying to accomplish:\n${input.goal}` : null,
    "",
    "— Sent by the SiteInsights in-app feedback form to the fixed operator address.",
  ].filter((line) => line !== null).join("\n");

  const row = (label: string, value: string) =>
    `<tr><td style="padding:7px 14px 7px 0;font-size:13px;color:#56636F;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td><td style="padding:7px 0;font-size:14px;color:#1B2631;">${value}</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SiteInsights user feedback</title></head>
<body style="margin:0;padding:0;background:#F5F7F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7F9;"><tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;">
      <tr><td style="padding:0 8px 18px;font-size:20px;font-weight:700;color:#1B2631;">SiteInsights <span style="font-size:12px;font-weight:500;color:#56636F;">by TalhaImtiazWorks</span></td></tr>
      <tr><td style="background:#FFFFFF;border:1px solid #D9E0E6;border-radius:14px;overflow:hidden;">
        <div style="height:4px;background:#0E436B;"></div>
        <div style="padding:30px 32px 26px;">
          <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#1B2631;">New user feedback — ${escapeHtml(cat)}</h1>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
            ${row("Satisfaction", escapeHtml(rating))}
            ${row("Account", `${escapeHtml(input.accountEmail ?? "(email on file unavailable)")} <span style="color:#56636F;font-size:12px;">(user ${escapeHtml(input.accountUserId)})</span>`)}
            ${row("Submitted", escapeHtml(input.submittedAt))}
            ${input.pageUrl ? row("Page", escapeHtml(input.pageUrl)) : ""}
            ${row("Reference", `<span style="font-size:12px;color:#56636F;">${escapeHtml(input.submissionId)}</span>`)}
          </table>
          <div style="background:#F5F7F9;border:1px solid #D9E0E6;border-radius:9px;padding:14px 16px;font-size:14px;line-height:1.6;color:#1B2631;white-space:pre-wrap;word-break:break-word;">${escapeHtml(input.message)}</div>
          ${input.goal ? `<p style="margin:16px 0 6px;font-size:13px;font-weight:600;color:#56636F;">They were trying to accomplish</p><div style="background:#F5F7F9;border:1px solid #D9E0E6;border-radius:9px;padding:12px 16px;font-size:13px;line-height:1.6;color:#3D4A57;white-space:pre-wrap;word-break:break-word;">${escapeHtml(input.goal)}</div>` : ""}
        </div>
      </td></tr>
      <tr><td align="center" style="padding:20px 8px 0;font-size:12px;line-height:1.6;color:#56636F;">Sent from the in-app feedback form · recipient is fixed server-side<br>SiteInsights · A TalhaImtiazWorks Product</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  const subject = `[SiteInsights feedback] ${cat}${input.rating !== null ? ` · ${input.rating}/5` : ""}`;
  return { subject, text, html };
}
