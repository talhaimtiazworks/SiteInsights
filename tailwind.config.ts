import type { Config } from "tailwindcss";
import tokens from "./src/lib/design-tokens.json";

const withVar = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: { DEFAULT: "1rem", sm: "1.5rem", lg: "2rem" }, screens: { "2xl": "1200px" } },
    extend: {
      colors: {
        background: withVar("background"), foreground: withVar("foreground"), card: withVar("card"),
        muted: withVar("muted"), "muted-foreground": withVar("muted-foreground"), secondary: withVar("secondary"),
        border: withVar("border"), ring: withVar("ring"), primary: withVar("primary"), "primary-foreground": withVar("primary-foreground"), accent: withVar("accent"),
        success: withVar("success"), "success-soft": withVar("success-soft"), warning: withVar("warning"), "warning-soft": withVar("warning-soft"),
        danger: withVar("danger"), "danger-soft": withVar("danger-soft"), info: withVar("info"), "info-soft": withVar("info-soft"),
        "brand-primary": tokens.colors.primary, "brand-amber": tokens.colors.amber, "brand-orange": tokens.colors.orange,
        "brand-yellow": tokens.colors.yellow, navy: tokens.colors.navy, charcoal: tokens.colors.charcoal, "on-dark": tokens.colors.white,
        gold: tokens.colors.accent, "gold-soft": tokens.colors.accentSoft, "blue-soft": tokens.colors.blueSoft, "primary-hover": tokens.colors.primaryHover, tint: tokens.colors.ivory,
      },
      fontFamily: {
        display: ["var(--font-display)", "ui-sans-serif", "system-ui", "Segoe UI", "Arial", "sans-serif"],
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      borderRadius: { xl: "0.625rem", "2xl": "0.75rem", "3xl": "0.875rem" },
      letterSpacing: { display: "-0.025em" },
      boxShadow: {
        soft: "0 1px 2px rgb(27 38 49 / 0.04)",
      },
    },
  },
  plugins: [],
};
export default config;
