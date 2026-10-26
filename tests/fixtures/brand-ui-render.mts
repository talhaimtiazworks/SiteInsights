/**
 * OFFLINE visual fixtures of the actual auth components. No auth server,
 * credentials, token exchange or production-route replacement is involved.
 * Run from root: worker/node_modules/.bin/tsx tests/fixtures/brand-ui-render.mts
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SignInClient } from "../../src/app/sign-in/sign-in-client";
import { SignUpClient } from "../../src/app/sign-up/sign-up-client";
import { ForgotPasswordClient } from "../../src/app/forgot-password/forgot-client";
import { ConfirmClient } from "../../src/app/auth/confirm/confirm-client";
import { ResetPasswordClient } from "../../src/app/account/reset-password/reset-client";
import { SiteFooter } from "../../src/components/site-footer";

const base = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const out = process.env.BRAND_FIXTURES_DIR ?? "/tmp/siteinsight-brand-fixtures";
const response = await fetch(base);
if (!response.ok) throw new Error(`App must be running at ${base}`);
const homepage = await response.text();
const css = [...homepage.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
if (!css.length) throw new Error("No compiled app stylesheet found");
const providers = { enabled: true, email: true, google: true, github: true, saml: false, signupDisabled: false, unavailable: false };
const forms = {
  "sign-in": createElement(SignInClient, { providers, next: "/dashboard", error: null, reason: null }),
  "sign-up": createElement(SignUpClient, { providers, next: "/dashboard" }),
  "forgot-password": createElement(ForgotPasswordClient),
  "confirm-invalid": createElement(ConfirmClient, { tokenHash: null, type: null, next: "/dashboard" }),
  "reset-password": createElement(ResetPasswordClient, { email: null }),
};
await mkdir(out, { recursive: true });
for (const [name, form] of Object.entries(forms)) {
  const content = renderToStaticMarkup(form);
  const footer = renderToStaticMarkup(createElement(SiteFooter));
  await writeFile(path.join(out, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SiteInsight ${name} — offline component QA fixture</title>${css.map((href) => `<link rel="stylesheet" href="${base}${href}">`).join("")}</head><body><p class="container pt-4 text-xs text-muted-foreground">Offline component QA fixture — no authentication requests or credentials.</p><main id="main">${content}</main>${footer}</body></html>`);
}
console.log(`Rendered ${Object.keys(forms).length} real auth component fixtures to ${out}`);
