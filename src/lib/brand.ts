/** Public product identity. intendedOrigin is a destination, NOT a runtime URL fallback. */
export const BRAND = {
  name: "SiteInsights",
  logo: "/brand/talhaimtiazworks-logo-320.png",
  logoOriginal: "/brand/talhaimtiazworks-logo.png",
  logoAlt: "SiteInsights by TalhaImtiazWorks — official logo",
  category: "AI-Powered Website Auditing",
  parent: "TalhaImtiazWorks",
  attribution: "A TalhaImtiazWorks Product",
  tagline: "Find website issues. Understand them. Fix them.",
  intendedOrigin: "https://siteinsight.xyz",
  description: "SiteInsights — AI-Powered Website Auditing by TalhaImtiazWorks. Find broken links, technical SEO, accessibility and performance issues, with evidence and practical fixes. AI explanations are available when configured.",
} as const;

export function brandCopyright(year: number = new Date().getFullYear()): string {
  return `© ${year} TalhaImtiazWorks. SiteInsights is a TalhaImtiazWorks product.`;
}
