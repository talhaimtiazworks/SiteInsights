"use client";

import tokens from "@/lib/design-tokens.json";
import { BRAND } from "@/lib/brand";
const C = tokens.colors;

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", margin: 0, background: C.ivory, color: C.text }}>
        <div style={{ textAlign: "center", padding: 24 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={BRAND.logo} width={96} height={96} alt={BRAND.logoAlt} style={{ width: 96, height: 96, objectFit: "contain" }} />
          <h1 style={{ fontSize: 28, marginBottom: 8 }}>SiteInsights is temporarily unavailable</h1>
          <p style={{ color: C.secondary }}>An unexpected error occurred. Please try again.</p>
          <p style={{ color: C.secondary, fontSize: 12 }}>A TalhaImtiazWorks Product</p>
          <div style={{ marginTop: 24, display: "flex", gap: 12, justifyContent: "center" }}>
            <button onClick={reset} style={{ padding: "10px 18px", borderRadius: 8, border: 0, background: C.primary, color: C.white, cursor: "pointer" }}>Try again</button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" style={{ padding: "10px 18px", borderRadius: 8, border: `1px solid ${C.border}`, color: C.text, textDecoration: "none" }}>Go home</a>
          </div>
        </div>
      </body>
    </html>
  );
}
