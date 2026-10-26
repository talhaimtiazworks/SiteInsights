import { publicPageMetadata } from "@/lib/config/metadata";
import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { getConfig } from "@/lib/config/env";

export const metadata = publicPageMetadata("/privacy", "Privacy policy", "What SiteInsights collects, why, and for how long.");

export default function PrivacyPage() {
  const cfg = getConfig();
  return (
    <div className="container max-w-3xl py-10">
      <PageHeader title="Privacy policy" description="What SiteInsights collects, why, and for how long." />
      <article className="prose-doc mt-8">
        <p>SiteInsights is a product created by TalhaImtiazWorks, not a separate company.</p>
        <h2>Summary</h2>
        <p>An account is required to run audits. SiteInsights does not use advertising or third-party tracking cookies. We store only what is needed to run audits, keep your history, provide your account and enforce fair-use limits.</p>
        <h2>What we collect</h2>
        <ul>
          <li><strong>Account data.</strong> Your email address, an optional display name and avatar URL, the sign-in methods you connected (for example Google or GitHub) and team memberships. Accounts are handled by our authentication provider, Supabase Auth. Passwords are never stored by SiteInsights: Supabase stores only a salted hash. Signing in sets first-party, HTTP-only session cookies (<code>sb-…</code>).</li>
          <li><strong>Anonymous identifier.</strong> A first-party, HTTP-only cookie (<code>sl_pid</code>) supports rate limiting and recovery of legacy records. It is not a sign-in session and never authorizes a new audit.</li>
          <li><strong>Hashed network identifier.</strong> Your IP address is converted into a keyed one-way hash used to apply usage limits per network. The raw IP address is not stored.</li>
          <li><strong>Scan data.</strong> The URLs you submit and the publicly accessible data collected from those websites (page titles, headings, links, HTTP status codes and similar technical metadata).</li>
          <li><strong>Usage events.</strong> Timestamps of scans and AI requests, used to calculate your remaining allowance.</li>
          <li><strong>Preferences.</strong> Your preferred AI provider, if you choose one. Theme choice is stored only in your browser.</li>
        </ul>
        <h2>AI providers</h2>
        <p>When you request an AI explanation or summary, the relevant findings (URLs, evidence excerpts and page metadata) are sent to the AI provider YOU selected — OpenRouter or Google Gemini — using your own API key (bring your own key). Your key stays in your browser’s memory, is sent once per AI request to our server over HTTPS so it can call the provider on your behalf, and is never stored, logged or shared with any other user. Your cookie, IP address and other personal data are not sent to the provider. These providers process data under their own terms and privacy policies.</p>
        <h2>Performance tests and browser rendering</h2>
        <p>If performance testing is enabled, the URL of the audited start page is sent to Google&apos;s PageSpeed Insights service, which loads that public page and returns performance data; Google processes it under its own terms. If browser rendering is enabled, audited pages are loaded by a separate browser service run by the operator of this site. Neither receives your cookie, IP address or any personal data.</p>
        <h2>Private reports and team access</h2>
        <p>Every audit requires a verified account. Report URLs and legacy access keys do not grant access on their own. Only the owner or a signed-in member of an organization with which the owner shared the audit may read it. Only the owner may change or re-run it.</p>
        <h2>Retention</h2>
        <p>Accounts keep their most recent audits ({cfg.plans.plans.free.historyLimit} on Free, {cfg.plans.plans.pro.historyLimit} on Pro, {cfg.plans.plans.business.historyLimit} on Business). Older audits and their data are deleted automatically. Usage events are retained only as needed for limit calculations. The credit ledger (amounts, operation and related audit, never payment details) is kept for the life of the account so balances can be audited. Production requires persistent database storage.</p>
        <h2>Prospects and shared reports</h2>
        <p>You can save audited websites as prospects with notes and contact details that you enter yourself. SiteInsights does not collect contact details from websites and never contacts anyone on your behalf. Prospects are private to your account. If you create a report link, anyone with that link can read that one report until it expires or you revoke it; only a hash of the link token is stored.</p>
        <h2>Payments</h2>
        <p>Payments are not enabled yet. When they are, card details will be handled entirely by the payment provider; SiteInsights will store only the plan, subscription status, billing period and the provider&apos;s subscription reference.</p>
        <h2>Your choices</h2>
        <p>You can edit your profile, export or delete audits, and delete your account under Account → Delete account. Account deletion removes your audits, preferences, usage records, memberships and sign-in account. Clearing browser cookies signs you out; sign in again to access your account-owned reports. Website owners can block the crawler through robots.txt—see <Link href="/help#crawler">About the crawler</Link>.</p>
        <h2>Contact</h2>
        <p>Questions about privacy? See the <Link href="/contact">contact page</Link>.</p>
      </article>
    </div>
  );
}
