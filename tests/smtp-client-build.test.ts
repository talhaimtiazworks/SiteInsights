/** Offline fixtures test the build scanner, never actual secrets or SMTP. */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSmtpClientBoundary } from "../scripts/email/check-client-boundary.mjs";
import { MAILJET_TEST_USER as USER, MAILJET_TEST_PASS as PASS, MAILJET_TEST_FROM as FROM, MAILJET_TEST_ENV as env } from "./fixtures/mailjet-smtp";
const roots: string[] = [];
async function fixture() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "siteinsight-smtp-build-")); roots.push(projectRoot);
  await mkdir(path.join(projectRoot, ".next/static/chunks"), { recursive: true });
  await mkdir(path.join(projectRoot, ".next/server/app"), { recursive: true });
  await writeFile(path.join(projectRoot, ".next/static/chunks/app.js"), 'console.info("SiteInsights")');
  await writeFile(path.join(projectRoot, ".next/server/app/index.html"), "<h1>SiteInsights</h1>");
  return projectRoot;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function privateResult(result: unknown) { const text = JSON.stringify(result); for (const value of [USER, PASS, FROM, encodeURIComponent(FROM), Buffer.from(PASS).toString("base64")]) expect(text).not.toContain(value); }
describe("compiled-output SMTP credential canaries", () => {
  it("requires explicit canaries, never labels a skipped check as a pass", async () => {
    expect(await checkSmtpClientBoundary({ env: {} })).toMatchObject({ ok: false, code: "smtp_canaries_missing" });
  });
  it("fails safely if there is no build", async () => {
    const projectRoot = await fixture(); await rm(path.join(projectRoot, ".next"), { recursive: true });
    const result = await checkSmtpClientBoundary({ projectRoot, env });
    expect(result).toMatchObject({ ok: false, code: "smtp_build_missing" }); privateResult(result);
  });
  it("passes only after inspecting both static/browser and compiled server output", async () => {
    const projectRoot = await fixture();
    const result = await checkSmtpClientBoundary({ projectRoot, env });
    expect(result).toMatchObject({ ok: true, filesScanned: 2, filesWithMatches: 0 }); privateResult(result);
  });
  it.each([
    ["static/chunks/app.js", USER],
    ["static/chunks/app.js", PASS],
    ["server/app/index.html", USER],
    ["server/app/index.html", encodeURIComponent(FROM)],
    ["static/chunks/app.js", Buffer.from(PASS).toString("base64")],
    ["server/app/index.html", FROM],
    ["static/chunks/app.js", Buffer.from(`${USER}:${PASS}`).toString("base64")],
    ["static/chunks/app.js", Buffer.from(`\0${USER}\0${PASS}`).toString("base64")],
  ])("detects leaked raw/encoded data in %s without printing the value", async (file, canary) => {
    const projectRoot = await fixture(); await writeFile(path.join(projectRoot, ".next", file), `unsafe: ${canary}`);
    const result = await checkSmtpClientBoundary({ projectRoot, env });
    expect(result).toMatchObject({ ok: false, code: "smtp_public_build_leak", filesWithMatches: 1 }); privateResult(result);
  });
  it("does not treat empty browser/server directories as a successfully inspected build", async () => {
    const projectRoot = await fixture();
    await rm(path.join(projectRoot, ".next/static/chunks/app.js"));
    const result = await checkSmtpClientBoundary({ projectRoot, env });
    expect(result).toMatchObject({ ok: false, code: "smtp_build_missing" }); privateResult(result);
  });
});
