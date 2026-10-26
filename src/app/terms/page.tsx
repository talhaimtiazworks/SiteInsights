import { publicPageMetadata } from "@/lib/config/metadata";
import Link from "next/link";
import { PageHeader } from "@/components/ui";

export const metadata = publicPageMetadata("/terms", "Terms of use", "The rules for using SiteInsights, a TalhaImtiazWorks product.");

export default function TermsPage() {
  return (
    <div className="container max-w-3xl py-10">
      <PageHeader title="Terms of use" description="The rules for using SiteInsights." />
      <article className="prose-doc mt-8">
        <p>SiteInsights is a product created by TalhaImtiazWorks, not a separate company.</p>
        <h2>Acceptable use</h2>
        <ul>
          <li>Only scan websites you own or are permitted to test. Scans are limited and polite, but you are responsible for the URLs you submit.</li>
          <li>Do not attempt to bypass usage limits, scan private networks, overload third-party websites or interfere with the service.</li>
          <li>Automated or bulk use of the service is not permitted without permission.</li>
        </ul>
        <h2>No warranty</h2>
        <p>SiteInsights is provided &quot;as is&quot;. Findings are produced by automated checks and may be incomplete or incorrect, especially for sites that rely on JavaScript or block automated requests. AI-generated explanations can contain mistakes. Review all recommendations before applying them; SiteInsights never makes changes to your website.</p>
        <h2>Scores</h2>
        <p>Scores summarise the findings of a single scan using the <Link href="/help#scoring">published formula</Link>. They are not guarantees of search rankings, traffic or compliance.</p>
        <h2>Availability</h2>
        <p>The free service may change, be limited or be discontinued at any time. Scan history may be deleted according to the retention rules described in the <Link href="/privacy">privacy policy</Link>.</p>
        <h2>Contact</h2>
        <p>See the <Link href="/contact">contact page</Link>.</p>
      </article>
    </div>
  );
}
