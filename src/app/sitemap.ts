import type { MetadataRoute } from "next";
import { metadataOrigin, PUBLIC_PATHS } from "@/lib/config/metadata";

/** Public documentation only; no account, auth, API or private audit links. */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = metadataOrigin();
  if (!origin) return [];
  return PUBLIC_PATHS.map((path) => ({ url: new URL(path, origin).href }));
}
