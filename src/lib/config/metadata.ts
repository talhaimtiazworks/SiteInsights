import type { Metadata } from "next";
import { BRAND } from "../brand";
import { resolveAppUrl } from "./app-url";

type Env = Record<string, string | undefined>;

/**
 * Metadata follows the configured deployment, just like auth links. Never
 * force the intended custom domain before its Vercel/DNS/auth cutover is ready.
 */
export function metadataOrigin(env: Env = process.env): string | undefined {
  const configured = resolveAppUrl(env).appUrl;
  if (configured) return configured;
  if (env.VERCEL_URL) {
    try {
      const u = new URL(`https://${env.VERCEL_URL}`);
      return u.origin;
    } catch { /* No absolute metadata on an unconfigured/local deployment. */ }
  }
  return undefined;
}

export const PUBLIC_PATHS = ["/", "/features", "/guide", "/about", "/help", "/contact", "/privacy", "/terms"] as const;

/** A dedicated social-card asset (1200×630) for a public page. */
export interface PublicOgImage {
  /** Site-relative path under /public, e.g. /brand/siteinsight-og-1200x630.png */
  path: string;
  width: 1200;
  height: 630;
  alt: string;
}

export function publicPageMetadata(path: string, title: string, description: string, image?: PublicOgImage): Metadata {
  const origin = metadataOrigin();
  const url = origin ? new URL(path, origin).href : undefined;
  const brandedTitle = path === "/" ? `${BRAND.name} — ${title}` : `${title} · ${BRAND.name}`;
  // og:image must be an absolute URL for crawlers; locally (no origin configured)
  // it degrades to a relative path, which metadataBase resolves once NEXT_PUBLIC_APP_URL/VERCEL_URL exists.
  const imageUrl = image ? (origin ? new URL(image.path, origin).href : image.path) : undefined;
  return {
    // A root page shares the layout segment, so Next does not apply its title template.
    title: path === "/" ? { absolute: brandedTitle } : title,
    description,
    ...(url ? { alternates: { canonical: url } } : {}),
    openGraph: {
      title: brandedTitle,
      description,
      siteName: BRAND.name,
      type: "website",
      ...(url ? { url } : {}),
      ...(image && imageUrl ? { images: [{ url: imageUrl, secureUrl: origin?.startsWith("https:") ? new URL(image.path, origin).href : imageUrl, width: image.width, height: image.height, type: "image/png", alt: image.alt }] } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: brandedTitle,
      description,
      ...(image && imageUrl ? { images: [{ url: imageUrl, alt: image.alt }] } : {}),
    },
  };
}

/** A product created by the parent organization, not a separate company. */
export function applicationStructuredData(origin: string | undefined = metadataOrigin()) {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: BRAND.name,
    description: `${BRAND.category}. ${BRAND.tagline}`,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    ...(origin ? { url: origin } : {}),
    creator: { "@type": "Organization", name: BRAND.parent },
    publisher: { "@type": "Organization", name: BRAND.parent },
  };
}
