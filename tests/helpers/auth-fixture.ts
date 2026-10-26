/** Test-only JWT issuer. The real Supabase SDK verifies RSA signatures against this local JWKS.
 * This is NOT a production auth provider or a getAuthState mock. Hosted/local GoTrue flows have separate integration tests.
 */
import http from "node:http";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { TestBrowser } from "./route-harness";

export async function startAuthFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomUUID();
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  let origin = "";
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/auth/v1/.well-known/jwks.json")) return void res.end(JSON.stringify({ keys: [jwk] }));
    res.writeHead(401).end(JSON.stringify({ error: "invalid_grant", error_code: "refresh_token_not_found", msg: "Test fixture has no refresh endpoint" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    configure() {
      process.env.NEXT_PUBLIC_SUPABASE_URL = origin;
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test_only_rsa_fixture";
    },
    signIn(browser: TestBrowser, options: { userId?: string; expired?: boolean; anonymous?: boolean; tampered?: boolean; email?: string } = {}) {
      const email = options.email ?? "fixture@example.test";
      const userId = options.userId ?? randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated", iss: origin + "/auth/v1", iat: now - 10, exp: options.expired ? now - 60 : now + 3600, session_id: randomUUID(), is_anonymous: options.anonymous ?? false, email, app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {} })).toString("base64url");
      const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
      const token = `${header}.${payload}.${options.tampered ? 'AAAA' + signature.slice(4) : signature}`;
      const session = { access_token: token, refresh_token: "test-only-no-refresh", expires_at: options.expired ? now - 60 : now + 3600, expires_in: options.expired ? -60 : 3600, token_type: "bearer", user: { id: userId, email, app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {} } };
      browser.cookies.set("sb-127-auth-token", "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url"));
      return userId;
    },
    close: () => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}
