/**
 * Test-only: renders one fixture URL with the real worker renderer, executed
 * by tsx exactly like the production worker (tsx compiles with keepNames,
 * which vitest does not). Used by tests/worker-render.integration.test.ts.
 * Usage: tsx tests/fixtures/tsx-render.mts <url> <port> <host>
 */
import { renderRequestSchema } from "../../src/lib/browser/protocol";
import { createRenderer } from "../../worker/src/render";

const [url, port, host] = process.argv.slice(2);
const renderer = createRenderer({
  overheadMs: 15_000,
  policyOverrides: {
    lookup: async (h: string) => (h === host ? [{ address: "127.0.0.2", family: 4 }] : [{ address: "203.0.113.10", family: 4 }]),
    isAllowedAddress: (ip: string) => ip === "127.0.0.2",
  },
});
const out = await renderer.render(renderRequestSchema.parse({ url, siteHosts: [host], allowedPorts: [Number(port)], navigationTimeoutMs: 8000, settleMs: 300, accessibility: true }));
process.stdout.write(JSON.stringify({ ok: out.ok, error: out.error, title: out.dom?.title ?? null, links: out.links.length, axe: out.axe?.violations.length ?? null }));
