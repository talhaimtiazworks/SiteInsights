import { Suspense } from "react";
import { SessionActivity } from "@/components/session-activity";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { BRAND } from "@/lib/brand";
import { metadataOrigin } from "@/lib/config/metadata";
import { SiteFooter } from "@/components/site-footer";
import { AuthLinkErrorBridge } from "@/components/auth-link-error-bridge";
import { NavigationProgress } from "@/components/navigation-progress";
import { AnalyticsTracker } from "@/components/analytics-tracker";
import { SiteHeader } from "@/components/site-header";
import localFont from "next/font/local";

// Self-hosted OFL typefaces (see src/app/fonts/provenance.json). No runtime font CDN.
const display = localFont({ src: "./fonts/BricolageGrotesque.woff2", variable: "--font-display", weight: "400 800", display: "swap", fallback: ["ui-sans-serif", "system-ui", "Segoe UI", "Arial", "sans-serif"] });
const sans = localFont({ src: "./fonts/Inter.woff2", variable: "--font-sans", weight: "400 700", display: "swap", fallback: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Arial", "sans-serif"] });
const mono = localFont({ src: "./fonts/JetBrainsMono.woff2", variable: "--font-mono", weight: "400 600", display: "swap", fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"] });

// Keep metadata on the actual deployment until the custom domain is configured.
const origin = metadataOrigin();

export const metadata: Metadata = {
  ...(origin ? { metadataBase: new URL(origin) } : {}),
  title: { default: `${BRAND.name} — ${BRAND.category}`, template: `%s · ${BRAND.name}` },
  description: BRAND.description,
  applicationName: BRAND.name,
  authors: [{ name: BRAND.parent }],
  creator: BRAND.parent,
  publisher: BRAND.parent,
  openGraph: { title: `${BRAND.name} — ${BRAND.category}`, description: BRAND.description, type: "website", siteName: BRAND.name },
  twitter: { card: "summary_large_image", title: `${BRAND.name} — ${BRAND.category}`, description: BRAND.description },
};

export const viewport: Viewport = {
  themeColor: "#FFFFFF",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="flex min-h-screen flex-col">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-4 focus:py-2 focus:shadow">
          Skip to content
        </a>
        <Suspense fallback={null}><NavigationProgress /></Suspense>
        <Suspense fallback={null}><AnalyticsTracker /></Suspense>
        <SessionActivity />
        <AuthLinkErrorBridge />
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
