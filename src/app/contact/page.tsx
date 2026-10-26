import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { SocialLinksSection } from "@/components/contact/social-links";
import { publicPageMetadata } from "@/lib/config/metadata";

export const metadata: Metadata = publicPageMetadata("/contact", "Contact", "Contact the SiteInsights team about reports, accounts, and product support.");

export default function ContactPage() {
  return (
    <div className="container max-w-5xl space-y-6 py-8 sm:py-10">
      <PageHeader title="Contact" description="Questions about an audit or your SiteInsights account? Start here." />
      {/* The support email and help-link cards were retired on this page; the official
          TalhaImtiazWorks social profiles are the contact surface. Facebook and YouTube
          remain excluded by design. */}
      <SocialLinksSection />
    </div>
  );
}
