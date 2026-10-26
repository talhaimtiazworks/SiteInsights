import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/brand";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: BRAND.name,
    short_name: BRAND.name,
    description: `${BRAND.category}. ${BRAND.tagline} ${BRAND.attribution}.`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#F8F7F3",
    theme_color: "#5D0217",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/siteinsight-icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
