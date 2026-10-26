/**
 * Public base URL of the app, used for links that leave the current request:
 * email confirmation / password reset / email change redirects, OAuth and SSO
 * callbacks, background hand-offs and social metadata.
 *
 *  1. NEXT_PUBLIC_APP_URL (explicit) — but never a development address
 *     (localhost, 127.x, 0.0.0.0, ::1, *.local) on Vercel: such a value is
 *     ignored and reported, so deployed emails can't point at localhost
 *     because of a copied .env. (Self-hosted production builds keep it with
 *     a warning, so local production-mode test runs work.)
 *  2. On Vercel's production deployment: https://$VERCEL_PROJECT_PRODUCTION_URL
 *     (a system variable Vercel sets to the project's production domain).
 *  3. Otherwise null → the request's own origin (local development, preview
 *     deployments). Supabase only follows redirects on its allow list.
 */
import type { ConfigIssue } from "./consistency";

type Env = Record<string, string | undefined>;

export interface AppUrlResolution {
  appUrl: string | null;
  source: "NEXT_PUBLIC_APP_URL" | "VERCEL_PROJECT_PRODUCTION_URL" | null;
  issues: ConfigIssue[];
}

const DEV_HOST = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|[^.]+\.local|[^.]+\.localhost)$/i;

export function isDevelopmentHost(hostname: string): boolean {
  return DEV_HOST.test(hostname);
}

export function resolveAppUrl(env: Env): AppUrlResolution {
  const issues: ConfigIssue[] = [];
  const development = env.NODE_ENV !== "production";
  const vercelProduction = env.VERCEL_ENV === "production";
  // Any Vercel deployment (production or preview) is unreachable at localhost.
  const onVercel = env.VERCEL === "1" || !!env.VERCEL_ENV;
  const productionHost = env.VERCEL_PROJECT_PRODUCTION_URL?.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "") || null;
  const raw = env.NEXT_PUBLIC_APP_URL?.trim() || null;

  if (raw) {
    let u: URL | null = null;
    try {
      u = new URL(raw);
      if (u.protocol !== "https:" && u.protocol !== "http:") u = null;
    } catch {
      u = null;
    }
    if (!u) {
      issues.push({ severity: "error", variables: ["NEXT_PUBLIC_APP_URL"], problem: "NEXT_PUBLIC_APP_URL is not a valid absolute http(s) URL, so it is ignored.", fix: "Set NEXT_PUBLIC_APP_URL to your production origin, e.g. https://siteinsight.xyz (only after domain setup) (no path), then redeploy." });
    } else if (onVercel && isDevelopmentHost(u.hostname)) {
      issues.push({
        severity: "error",
        variables: ["NEXT_PUBLIC_APP_URL"],
        problem: "NEXT_PUBLIC_APP_URL points to a development address (localhost) on a Vercel deployment, so it is ignored — otherwise confirmation and reset emails would link to localhost.",
        fix: "Set NEXT_PUBLIC_APP_URL to your production origin in Vercel → Settings → Environment Variables (Production), e.g. https://siteinsight.xyz (only after domain setup), and redeploy. Keep http://localhost:3000 only in your local .env.local.",
      });
    } else {
      if (!development && isDevelopmentHost(u.hostname)) {
        // Self-hosted production build (e.g. a local `next start` test run): keep it, but say so.
        issues.push({ severity: "warning", variables: ["NEXT_PUBLIC_APP_URL"], problem: "NEXT_PUBLIC_APP_URL points to a development address in a production build; email and sign-in links will only work on this machine.", fix: "Use your public https:// origin for a real deployment." });
      } else if (!development && u.protocol === "http:") {
        issues.push({ severity: "warning", variables: ["NEXT_PUBLIC_APP_URL"], problem: "NEXT_PUBLIC_APP_URL uses http:// in production.", fix: "Use the https:// origin of your deployment." });
      }
      if (u.pathname !== "/" || u.search) {
        issues.push({ severity: "warning", variables: ["NEXT_PUBLIC_APP_URL"], problem: "NEXT_PUBLIC_APP_URL contains a path or query; only the origin is used.", fix: "Set it to the bare origin, e.g. https://siteinsight.xyz (only after domain setup)." });
      }
      return { appUrl: u.origin, source: "NEXT_PUBLIC_APP_URL", issues };
    }
  }

  if (vercelProduction && productionHost && !isDevelopmentHost(productionHost)) {
    if (!raw) {
      issues.push({ severity: "warning", variables: ["NEXT_PUBLIC_APP_URL"], problem: `NEXT_PUBLIC_APP_URL is not set; using Vercel's production domain (VERCEL_PROJECT_PRODUCTION_URL) for email and sign-in links.`, fix: "Set NEXT_PUBLIC_APP_URL to your production origin so links stay stable if you add a custom domain." });
    }
    return { appUrl: `https://${productionHost}`, source: "VERCEL_PROJECT_PRODUCTION_URL", issues };
  }
  if (!development && !raw && env.VERCEL !== "1") {
    issues.push({ severity: "warning", variables: ["NEXT_PUBLIC_APP_URL"], problem: "NEXT_PUBLIC_APP_URL is not set; links in emails use the host of each request.", fix: "Set NEXT_PUBLIC_APP_URL to the public origin of this deployment." });
  }
  return { appUrl: null, source: null, issues };
}
