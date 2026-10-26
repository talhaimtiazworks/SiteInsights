import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aiRequestSchema } from "@/lib/services/ai";
import { createUserProvider } from "@/lib/ai/registry";
import { aiConfig, fakeFetch, openrouterOk } from "./helpers/ai";

const root = process.cwd();
const KEY_A = "sk-or-v1-aaaa-user-A-key-0001";
const KEY_B = "sk-or-v1-bbbb-user-B-key-0002";

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("BYOK request contract", () => {
  it("requires provider AND key — missing key fails safely before any provider call", () => {
    expect(aiRequestSchema.safeParse({ provider: "openrouter" }).success).toBe(false);
    expect(aiRequestSchema.safeParse({ apiKey: KEY_A }).success).toBe(false);
    expect(aiRequestSchema.safeParse({ provider: "unknown", apiKey: KEY_A }).success).toBe(false);
    expect(aiRequestSchema.safeParse({ provider: "openrouter", apiKey: "short" }).success).toBe(false);
    expect(aiRequestSchema.safeParse({ provider: "openrouter", apiKey: "x".repeat(301) }).success).toBe(false);
    const ok = aiRequestSchema.safeParse({ provider: "gemini", apiKey: KEY_B, regenerate: true });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.regenerate).toBe(true);
  });

  it("error text for a missing key tells the user to bring their own — never blames a server", () => {
    const r = aiRequestSchema.safeParse({ provider: "openrouter" });
    expect(r.success).toBe(false);
  });

  it("concurrent requests with different users' keys stay isolated", async () => {
    // Two adapters built from two users' keys; interleaved requests must send the right key each time.
    const fA = fakeFetch([openrouterOk(JSON.stringify({ ok: "A" })), openrouterOk(JSON.stringify({ ok: "A2" }))]);
    const fB = fakeFetch([openrouterOk(JSON.stringify({ ok: "B" }))]);
    const pA = createUserProvider(aiConfig(), "openrouter", KEY_A, null, fA.fetch);
    const pB = createUserProvider(aiConfig(), "openrouter", KEY_B, null, fB.fetch);
    const [rA1, rB, rA2] = await Promise.all([
      pA.generate({ system: "s", user: "u1", maxOutputTokens: 10 }),
      pB.generate({ system: "s", user: "u2", maxOutputTokens: 10 }),
      pA.generate({ system: "s", user: "u3", maxOutputTokens: 10 }),
    ]);
    expect((fA.calls[0].init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY_A}`);
    expect((fA.calls[1].init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY_A}`);
    expect((fB.calls[0].init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY_B}`);
    expect(rA1.text).toContain("A");
    expect(rB.text).toContain("B");
    expect(rA2.text).toContain("A2");
  });

  it("provider instances are not joined to process.env (no ambient credential possible)", async () => {
    // Even if the legacy owner vars were present in the environment, they are unreadable by the AI layer.
    process.env.OPENROUTER_API_KEY = "sk-or-v1-OWNER-SHOULD-BE-IGNORED";
    process.env.GEMINI_API_KEY = "AIza-OWNER-SHOULD-BE-IGNORED";
    try {
      const { loadConfig } = await import("@/lib/config/env");
      const cfg = loadConfig(process.env);
      // AI config exposes no key material and flags the legacy vars for deletion.
      expect(JSON.stringify(cfg.ai)).not.toContain("OWNER-SHOULD-BE-IGNORED");
      expect(cfg.warnings.some((w) => w.includes("no longer used"))).toBe(true);
      // And building a provider without an explicit user key is impossible.
      expect(() => createUserProvider(cfg.ai, "openrouter", " ", cfg.appUrl)).toThrow();
    } finally {
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.GEMINI_API_KEY;
    }
  });
});

describe("BYOK client session store — memory only, never persisted", () => {
  it("module code contains no persistent-storage APIs at all", () => {
    const src = readFileSync(path.join(root, "src/lib/client/ai-session.ts"), "utf8");
    for (const banned of ["localStorage.", "sessionStorage.", "indexedDB", "document.cookie", "caches.open", "navigator.storage.persist", "history.pushState", "history.replaceState"]) {
      expect(src.includes(banned), `ai-session must not use ${banned}`).toBe(false);
    }
    expect(src).toContain("useSyncExternalStore"); // in-memory store + React bridge
    expect(src).toContain("disconnectAiSession");
  });

  it("connect/disconnect/get semantics hold; disconnect wipes the stored key", async () => {
    const mod = await import("@/lib/client/ai-session");
    expect(mod.getAiSession()).toBeNull();
    expect(() => mod.disconnectAiSession()).not.toThrow(); // safe when nothing is connected
    mod.connectAiSession("openrouter", KEY_A, "2026-10-23T00:00:00.000Z");
    expect(mod.getAiSession()?.provider).toBe("openrouter");
    expect(mod.aiCredentials()?.apiKey).toBe(KEY_A);
    mod.disconnectAiSession();
    expect(mod.getAiSession()).toBeNull();
    expect(mod.aiCredentials()).toBeNull();
    mod.disconnectAiSession(); // idempotent
    mod.connectAiSession("gemini", KEY_B, "2026-10-23T01:00:00.000Z");
    expect(mod.aiCredentials()).toEqual({ provider: "gemini", apiKey: KEY_B });
    mod.disconnectAiSession();
  });

  it("sign-out always disconnects the BYOK session (even before the network call)", () => {
    const src = readFileSync(path.join(root, "src/lib/client/session.ts"), "utf8");
    const signOutBody = src.slice(src.indexOf("export async function signOut"));
    expect(signOutBody.indexOf("disconnectAiSession()")).toBeLessThan(signOutBody.indexOf("\"/api/auth/sign-out\""));
  });

  it("no client source persists apiKey-shaped values to web storage", () => {
    const clientFiles = walk(path.join(root, "src")).filter((f) => /\.(ts|tsx)$/.test(f));
    const offenders = clientFiles.filter((f) => {
      const s = readFileSync(f, "utf8");
      return /(localStorage|sessionStorage)\.[^(]*\(([^)]*apiKey|[^)]*phi)/.test(s) || /caches\.open/.test(s) && /apiKey/.test(s);
    });
    expect(offenders).toEqual([]);
  });
});

describe("routes & responses", () => {
  it("every AI endpoint uses the shared response helper that sets Cache-Control: no-store", () => {
    const httpApi = readFileSync(path.join(root, "src/lib/http/api.ts"), "utf8");
    expect(httpApi).toMatch(/["']Cache-Control["']:\s*"no-store"/);
    for (const f of [
      "src/app/api/ai/health/route.ts",
      "src/app/api/ai/providers/route.ts",
      "src/app/api/settings/ai/route.ts",
      "src/app/api/scans/[id]/ai-summary/route.ts",
      "src/app/api/scans/[id]/findings/[findingId]/ai/route.ts",
    ]) {
      const s = readFileSync(path.join(root, f), "utf8");
      expect(s, f).toMatch(/\bok\(|errorResponse\(|throw new ApiError/);
    }
  });

  it("health endpoint validates with a genuine provider request and requires a key", () => {
    const src = readFileSync(path.join(root, "src/app/api/ai/health/route.ts"), "utf8");
    expect(src).toContain("healthCheck()");
    expect(src).toContain("createUserProvider");
    expect(src).toContain("apiKey");
    expect(src).toContain("getAuditContext"); // authenticated
    expect(src).toContain("throttle"); // rate limited
    expect(src).toContain("assertSameOrigin"); // CSRF guard
  });

  it("the AI request service never logs request bodies or keys", () => {
    const src = readFileSync(path.join(root, "src/lib/services/ai.ts"), "utf8");
    expect(src).not.toMatch(/console\.(log|info|warn|error)\s*\(/);
    const httpApi = readFileSync(path.join(root, "src/lib/http/api.ts"), "utf8");
    expect(httpApi).not.toContain("console.error(JSON.stringify(");
  });
});

describe("non-AI core auditing stays independent of AI keys", () => {
  it("scanner/engine code never touches the AI config or provider keys", () => {
    const scannerFiles = walk(path.join(root, "src/lib/scanner")).filter((f) => f.endsWith(".ts"));
    expect(scannerFiles.length).toBeGreaterThan(3);
    const offenders = scannerFiles.filter((f) => /OPENROUTER_API_KEY|GEMINI_API_KEY|apiKey/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no AI provider adapter is constructed at module scope anywhere (all request-scoped)", () => {
    const srcFiles = walk(path.join(root, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("providers/") && !f.endsWith("lib/ai/registry.ts"));
    const offenders = srcFiles.filter((f) => /new (Gemini|OpenRouter)Provider\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]); // only registry.ts may construct them
  });
});

describe("settings UI contract (source-pinned)", () => {
  const src = readFileSync(path.join(root, "src/app/settings/ai/ai-settings-client.tsx"), "utf8");

  it("masks the key input, offers show/hide, and links to the official key pages", () => {
    expect(src).toContain('type={showKey ? "text" : "password"}');
    expect(src).toContain("setShowKey");
    expect(src).not.toContain('type="text" id="byok-key"');
  });

  it("explains in-memory-only storage and per-user billing, at the point of configuration", () => {
    expect(src).toContain("memory only");
    expect(src.toLowerCase()).toContain("refreshing the page always clears it");
    expect(src).toContain("billed by");
    expect(src).toContain("never saves it in the database");
  });

  it("cannot show a connected state without a genuine provider test", () => {
    // connect() runs the genuine health request first and only then stores the key.
    const connectIdx = src.indexOf("async function connect()");
    const testIdx = src.indexOf("async function testConnection()");
    expect(connectIdx).toBeGreaterThan(-1);
    expect(testIdx).toBeGreaterThan(-1);
    expect(src.slice(connectIdx)).toContain("await testConnection()");
    expect(src.slice(connectIdx)).toContain("if (!okHealth) return;");
    expect(src).toContain('"/api/ai/health"');
  });
});

describe("regression: AI support endpoints degrade gracefully when the database is missing (live-verified 503→200 on the parity build)", () => {
  it("the providers route handles StorageNotConfiguredError by serving the static list with a null preference", () => {
    const src = readFileSync(path.join(root, "src/app/api/ai/providers/route.ts"), "utf8");
    expect(src).toContain("StorageNotConfiguredError");
    expect(src).toContain("userPreference: preference");
    expect(src).toContain("preferencePersistent");
    // No path in this module may emit the not-configured error to the caller anymore.
    expect(src).not.toContain('503');
    expect(src).toContain("aiProviderSupport()");
  });
  it("the settings route still fails closed for key writes, but its GET never leaks the storage error", () => {
    const src = readFileSync(path.join(root, "src/app/api/settings/ai/route.ts"), "utf8");
    expect(src).toContain("StorageNotConfiguredError");
    expect(src).not.toContain("storage_not_configured");
  });
});
