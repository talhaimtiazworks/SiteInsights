import type { MetadataRoute } from "next";
import { metadataOrigin } from "@/lib/config/metadata";

export default function robots(): MetadataRoute.Robots {
  const origin = metadataOrigin();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/auth/", "/account", "/dashboard", "/scans/", "/audit/", "/settings/", "/usage", "/sign-in", "/sign-up", "/forgot-password", "/r/", "/billing"],
    },
    ...(origin ? { sitemap: `${origin}/sitemap.xml` } : {}),
  };
}
