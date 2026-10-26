#!/usr/bin/env node
/** Offline build inspection. Use ONLY synthetic canaries when building for this check. */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function checkSmtpClientBoundary({ projectRoot = process.cwd(), env = process.env } = {}) {
  const values = [env.SMTP_USER, env.SMTP_PASS, env.EMAIL_FROM];
  if (values.some((value) => !value || value.length < 12)) return { ok: false, code: "smtp_canaries_missing", message: "Set synthetic SMTP_USER, SMTP_PASS and EMAIL_FROM canaries before the build and this check. No value is printed." };
  const configured = [...values, `${env.SMTP_USER}:${env.SMTP_PASS}`, `\0${env.SMTP_USER}\0${env.SMTP_PASS}`];
  const needles = [...new Set(configured.flatMap((value) => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString("base64")]))].map((value) => Buffer.from(value));
  let filesScanned = 0;
  let filesWithMatches = 0;
  async function walk(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await walk(file);
      else if (item.isFile()) {
        const content = await readFile(file);
        filesScanned++;
        if (needles.some((needle) => content.includes(needle))) filesWithMatches++;
      }
    }
  }
  try {
    // Browser chunks/assets and prerendered HTML/RSC; also inspect compiled server
    // output as defense-in-depth. Build caches/dependencies are intentionally not inspected.
    await walk(path.join(projectRoot, ".next/static"));
    const staticFiles = filesScanned;
    await walk(path.join(projectRoot, ".next/server"));
    if (!staticFiles || filesScanned === staticFiles) throw new Error("Empty production build output");
  } catch {
    return { ok: false, code: "smtp_build_missing", message: "Run a production build with the same synthetic canaries first. No filesystem exception details are printed." };
  }
  if (filesWithMatches) return { ok: false, code: "smtp_public_build_leak", filesScanned, filesWithMatches, message: "A synthetic SMTP value was found in compiled output. Do not deploy; inspect the build privately. No matching value or content is printed." };
  return { ok: true, code: "smtp_client_boundary_passed", filesScanned, filesWithMatches: 0, message: "Synthetic SMTP values were absent from all checked browser and compiled server output. This is not a delivery test." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkSmtpClientBoundary();
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
