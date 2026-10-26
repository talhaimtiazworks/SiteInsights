import type { NextConfig } from "next";

/**
 * Security headers applied to every response.
 * FRAME_ANCESTORS controls which origins may embed the app in an iframe
 * (clickjacking protection). Defaults to same-origin only.
 * Note: headers are compiled at build time — redeploy after changing it.
 */
const frameAncestors = process.env.FRAME_ANCESTORS?.trim() || "'self'";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Content-Security-Policy", value: `frame-ancestors ${frameAncestors}; base-uri 'self'; form-action 'self'; object-src 'none'` },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    "/api/scans/*/report.pdf": ["./public/brand/talhaimtiazworks-logo-640.png", "./scripts/brand/fonts/*", "./scripts/brand/fonts/ui/*"],
    "/api/share/*/report.pdf": ["./public/brand/talhaimtiazworks-logo-640.png", "./scripts/brand/fonts/*", "./scripts/brand/fonts/ui/*"],
  },
  // Preview hosts may embed only when explicitly configured via FRAME_ANCESTORS.
  allowedDevOrigins: ["*.e2b.app"],
  poweredByHeader: false,
  serverExternalPackages: ["postgres"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
