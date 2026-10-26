#!/usr/bin/env node
/** Audit active display copy, not compatibility identifiers or historical SQL. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const skipDirs = new Set(["node_modules", ".next", ".git", "__pycache__", "coverage", "build", "dist", "out"]);
// SQL history and the browser test's negative old-name assertions are not display copy.
const historical = new Set(["src/lib/db/migrations.ts", "scripts/smoke/branding.mjs"]);
const self = "scripts/brand/check-branding.mjs";
const failures = [];
let checked = 0;
function walk(dir) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) { if (!skipDirs.has(entry.name)) walk(relative); continue; }
    if (!entry.isFile() || relative === self || historical.has(relative)) continue;
    if (!/\.(tsx?|mjs|py|svg|html|txt|json|css)$/.test(entry.name)) continue;
    checked++;
    const content = readFileSync(path.join(root, relative), "utf8");
    // Technical tokens such as SiteLensAI / sitelens_private are not display names.
    if (/\bSiteLens(?:\s+AI)?\b/.test(content) || /sitelens-(?:logo|mark|icon)(?:[-.])/i.test(content)) failures.push(`${relative}: obsolete product display name/asset`);
    if (relative.startsWith("src/") && /https:\/\/sitelens-ai\.vercel\.app/.test(content)) failures.push(`${relative}: hard-coded legacy deployment URL`);
  }
}
for (const dir of ["src", "public", "supabase", "scripts", "worker/src"]) walk(dir);
const essential = [
  "public/brand/talhaimtiazworks-logo.png", "public/brand/talhaimtiazworks-logo-160.png", "public/brand/talhaimtiazworks-logo-320.png", "public/brand/talhaimtiazworks-logo-640.png", "public/brand/official-logo.json",
  "src/lib/design-tokens.json", "src/app/brand-tokens.css", "src/components/branded-loading.tsx", "src/lib/auth/audit-policy.ts",
  "src/lib/brand.ts", "src/lib/config/metadata.ts", "src/app/about/page.tsx", "src/app/robots.ts", "src/app/sitemap.ts", "src/app/manifest.ts",
  "public/brand/siteinsight-logo.svg", "public/brand/siteinsight-logo-dark.svg", "public/brand/siteinsight-logo-mono.svg", "public/brand/siteinsight-mark.svg", "public/brand/siteinsight-mark-mono.svg", "public/brand/siteinsight-icon.svg",
  "public/brand/icon-192.png", "public/brand/icon-512.png", "src/app/favicon.ico", "src/app/apple-icon.png", "src/app/icon.svg", "public/favicon.svg",
  "src/app/opengraph-image.png", "src/app/opengraph-image.alt.txt", "src/app/twitter-image.png", "src/app/twitter-image.alt.txt",
];
for (const file of essential) if (!existsSync(path.join(root, file))) failures.push(`Missing ${file}`);
for (const dir of [".", "worker"]) {
  const pkg = JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(root, dir, "package-lock.json"), "utf8"));
  const name = dir === "." ? "siteinsight" : "siteinsight-browser-worker";
  if (pkg.name !== name || lock.name !== name || lock.packages[""].name !== name) failures.push(`${dir}: package/lock identity mismatch`);
}
const logo = readFileSync(path.join(root, "public/brand/talhaimtiazworks-logo.png"));
const artwork = JSON.parse(readFileSync(path.join(root, "public/brand/official-logo.json"), "utf8"));
if (createHash("sha256").update(logo).digest("hex") !== artwork.originalSHA256) failures.push("Official logo differs from the supplied artwork fingerprint");
if (logo.readUInt32BE(16) !== 1141 || logo.readUInt32BE(20) !== 1141) failures.push("Official logo canvas changed");
execFileSync(process.execPath, [path.join(root, "scripts/brand/generate-tokens.mjs"), "--check"], { stdio: "inherit" });
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`SiteInsights branding check passed: ${checked} active text files; ${essential.length} required assets/routes present. Historical SQL, legacy protocols and compatibility test fixtures intentionally retained (docs/REBRAND.md).`);
