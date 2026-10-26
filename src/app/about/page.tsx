import { BRAND } from "@/lib/brand";
import { publicPageMetadata } from "@/lib/config/metadata";
import { LogoMark, Wordmark } from "@/components/brand";
import { ButtonLink, Card, PageHeader } from "@/components/ui";

export const metadata = publicPageMetadata("/about", "About SiteInsights", "SiteInsights is an AI-Powered Website Auditing product created by TalhaImtiazWorks. Evidence first, practical fixes next.");

export default function AboutPage() {
  return (
    <div className="container max-w-4xl py-10 sm:py-16">
      <PageHeader title="About SiteInsights" description={BRAND.category} />
      <Card className="mt-8 p-6 sm:p-8">
        <div className="flex items-center gap-3"><LogoMark className="h-10 w-10" /><Wordmark className="text-2xl" /></div>
        <p className="mt-5 text-xl font-semibold tracking-tight">{BRAND.tagline}</p>
        <div className="mt-4 space-y-4 text-sm leading-7 text-muted-foreground">
          <p>SiteInsights is a product created by <strong className="font-semibold text-foreground">TalhaImtiazWorks</strong>, not a separate company. SiteInsights is the product identity; TalhaImtiazWorks is the parent brand behind it.</p>
          <p>We help you review broken links, technical SEO, accessibility, rendering and performance issues. Findings come from documented checks and include evidence, severity and recommended fixes. Optional AI explanations help you understand verified findings; they do not replace the underlying checks.</p>
          <p>Available checks depend on the deployment configuration. Browser rendering, PageSpeed performance tests and AI explanations require their respective services. Automated results are not a security certification or accessibility-conformance claim; review them before making changes.</p>
        </div>
        <p className="mt-6 text-xs font-medium text-muted-foreground">{BRAND.attribution}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <ButtonLink href="/audit/new">Start an audit</ButtonLink>
          <ButtonLink href="/help" variant="outline">How the checks work</ButtonLink>
          <ButtonLink href="/contact" variant="ghost">Contact</ButtonLink>
        </div>
      </Card>
    </div>
  );
}
