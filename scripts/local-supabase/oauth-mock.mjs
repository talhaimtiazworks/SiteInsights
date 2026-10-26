#!/usr/bin/env node
/**
 * Local stand-in for GitHub and Google OAuth, used to test the complete
 * SiteInsight → Supabase Auth (GoTrue) → provider → /auth/callback flow
 * without real provider credentials. GoTrue runs its normal, unmodified
 * GitHub and Google code paths: /etc/hosts maps the provider hostnames to this
 * server, which presents a certificate from a local test CA (GoTrue trusts it
 * via SSL_CERT_FILE). See docs/TESTING.md › OAuth end-to-end.
 *
 * Implements:
 *   GitHub  https://github.com/login/oauth/authorize, /login/oauth/access_token
 *           https://api.github.com/user, /user/emails
 *   Google  https://accounts.google.com/.well-known/openid-configuration, /o/oauth2/v2/auth, /jwks
 *           https://oauth2.googleapis.com/token (RS256-signed id_token), https://openidconnect.googleapis.com/v1/userinfo
 * Validates client_id, client_secret, redirect_uri and the authorization code
 * like the real providers. A control API on http://127.0.0.1:${CONTROL_PORT}
 * sets the identity for the next sign-in, or makes the user "cancel".
 *
 * Env: OAUTH_MOCK_CERT, OAUTH_MOCK_KEY (PEM), GITHUB_CLIENT_ID/SECRET,
 *      GOOGLE_CLIENT_ID/SECRET, PORT (443), CONTROL_PORT (7443).
 */
import { createSign, generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const env = process.env;
const PORT = Number(env.PORT || 443);
const CONTROL_PORT = Number(env.CONTROL_PORT || 7443);
const clients = {
  github: { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET },
  google: { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET },
};
for (const [p, c] of Object.entries(clients)) if (!c.id || !c.secret) throw new Error(`Missing ${p.toUpperCase()}_CLIENT_ID/SECRET`);

const ISSUER = "https://accounts.google.com";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = randomBytes(8).toString("hex");
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

/** Identity used for the next authorization, per provider (set via the control API). */
const next = {
  github: { mode: "approve", id: 424242, login: "octo-tester", name: "Octo Tester", email: "octo@sitelens.localtest", avatar: "https://avatars.githubusercontent.com/u/424242?v=4" },
  google: { mode: "approve", sub: "1093847561234", name: "Gloria Google", email: "gloria@sitelens.localtest", picture: "https://lh3.googleusercontent.com/a/test-picture" },
};
const codes = new Map(); // code → { provider, identity, redirectUri, clientId, exp }
const tokens = new Map(); // access token → { provider, identity }
const log = [];
const note = (m) => {
  log.push(`${new Date().toISOString()} ${m}`);
  if (log.length > 200) log.shift();
  console.log(`[oauth-mock] ${m}`);
};

const b64u = (b) => Buffer.from(b).toString("base64url");
function signJwt(claims) {
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }));
  const body = b64u(JSON.stringify(claims));
  const s = createSign("RSA-SHA256");
  s.update(`${head}.${body}`);
  return `${head}.${body}.${s.sign(privateKey).toString("base64url")}`;
}
const eq = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string";
  res.writeHead(status, { "content-type": isJson ? "application/json" : "text/plain", "cache-control": "no-store", ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return (req.headers["content-type"] || "").includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw));
}
function basicAuth(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return {};
  const [id, secret] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":").map(decodeURIComponent);
  return { client_id: id, client_secret: secret };
}

function authorize(provider, url, res) {
  const q = url.searchParams;
  const c = clients[provider];
  const redirectUri = q.get("redirect_uri");
  if (q.get("client_id") !== c.id) return send(res, 400, `invalid client_id`);
  if (!redirectUri) return send(res, 400, "redirect_uri required");
  if (provider === "google" && q.get("response_type") !== "code") return send(res, 400, "response_type must be code");
  const target = new URL(redirectUri);
  if (q.get("state")) target.searchParams.set("state", q.get("state"));
  const ident = next[provider];
  if (ident.mode === "deny") {
    note(`${provider} authorize → user cancelled`);
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_description", provider === "github" ? "The user has denied your application access." : "access_denied");
    return send(res, 302, "", { location: target.toString() });
  }
  const code = randomBytes(16).toString("hex");
  codes.set(code, { provider, identity: { ...ident }, redirectUri, clientId: c.id, exp: Date.now() + 60_000 });
  note(`${provider} authorize → code issued (redirect_uri ok, scope=${q.get("scope") ?? ""})`);
  target.searchParams.set("code", code);
  send(res, 302, "", { location: target.toString() });
}

async function token(provider, req, res) {
  const body = { ...(await readBody(req)), ...basicAuth(req) };
  const c = clients[provider];
  const entry = codes.get(body.code);
  codes.delete(body.code); // single use
  if (!eq(body.client_id, c.id) || !eq(body.client_secret, c.secret)) {
    note(`${provider} token → invalid client credentials`);
    return send(res, 401, { error: "invalid_client" });
  }
  if (!entry || entry.provider !== provider || entry.exp < Date.now()) return send(res, 400, { error: provider === "github" ? "bad_verification_code" : "invalid_grant" });
  if (body.redirect_uri && body.redirect_uri !== entry.redirectUri) return send(res, 400, { error: "redirect_uri_mismatch" });
  const accessToken = `${provider}-at-${randomBytes(12).toString("hex")}`;
  tokens.set(accessToken, { provider, identity: entry.identity });
  note(`${provider} token → issued (client secret verified)`);
  if (provider === "github") return send(res, 200, { access_token: accessToken, token_type: "bearer", scope: "user:email" });
  const now = Math.floor(Date.now() / 1000);
  const i = entry.identity;
  const idToken = signJwt({ iss: ISSUER, aud: c.id, azp: c.id, sub: i.sub, email: i.email, email_verified: true, name: i.name, picture: i.picture, iat: now, exp: now + 3600 });
  send(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 3599, scope: "openid email profile", id_token: idToken });
}

function bearer(req, provider) {
  const h = req.headers.authorization || "";
  const t = h.replace(/^(Bearer|token)\s+/i, "");
  const v = tokens.get(t);
  return v && v.provider === provider ? v.identity : null;
}

const handler = async (req, res) => {
  try {
    const host = (req.headers.host || "").split(":")[0];
    const url = new URL(req.url, `https://${host}`);
    const p = url.pathname;
    if (host === "github.com" && p === "/login/oauth/authorize") return authorize("github", url, res);
    if (host === "github.com" && p === "/login/oauth/access_token" && req.method === "POST") return token("github", req, res);
    if (host === "api.github.com" && (p === "/user" || p === "/user/emails")) {
      const i = bearer(req, "github");
      if (!i) return send(res, 401, { message: "Bad credentials" });
      if (p === "/user") return send(res, 200, { id: i.id, login: i.login, name: i.name, email: null, avatar_url: i.avatar });
      return send(res, 200, [{ email: i.email, primary: true, verified: true, visibility: "private" }]);
    }
    if (host === "accounts.google.com" && p === "/.well-known/openid-configuration") {
      return send(res, 200, {
        issuer: ISSUER,
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
        jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid", "email", "profile"],
      });
    }
    if (host === "accounts.google.com" && p === "/o/oauth2/v2/auth") return authorize("google", url, res);
    if (host === "www.googleapis.com" && p === "/oauth2/v3/certs") return send(res, 200, { keys: [jwk] });
    if (host === "oauth2.googleapis.com" && p === "/token" && req.method === "POST") return token("google", req, res);
    if ((host === "openidconnect.googleapis.com" && p === "/v1/userinfo") || (host === "www.googleapis.com" && p === "/userinfo/v2/me")) {
      const i = bearer(req, "google");
      if (!i) return send(res, 401, { error: "invalid_token" });
      return send(res, 200, { sub: i.sub, id: i.sub, email: i.email, email_verified: true, verified_email: true, name: i.name, picture: i.picture });
    }
    note(`unhandled ${req.method} https://${host}${p}`);
    send(res, 404, { error: "not_found" });
  } catch (err) {
    note(`error ${err?.message}`);
    send(res, 500, { error: "mock_error" });
  }
};
const tls = { cert: readFileSync(env.OAUTH_MOCK_CERT), key: readFileSync(env.OAUTH_MOCK_KEY) };
// Both loopback families: /etc/hosts maps the provider names to 127.0.0.1 and ::1.
for (const addr of ["127.0.0.1", "::1"]) https.createServer(tls, handler).listen(PORT, addr, () => console.log(`[oauth-mock] HTTPS on ${addr}:${PORT}`));

// Control API (loopback only): POST /next {provider, ...identity, mode: "approve"|"deny"}; GET /log
http
  .createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/next") {
      const b = await readBody(req);
      if (!next[b.provider]) return send(res, 400, { error: "provider" });
      const { provider, ...rest } = b;
      next[provider] = { ...next[provider], ...rest };
      return send(res, 200, { ok: true });
    }
    if (req.url === "/log") return send(res, 200, { log });
    send(res, 404, { error: "not_found" });
  })
  .listen(CONTROL_PORT, "127.0.0.1", () => console.log(`[oauth-mock] control on 127.0.0.1:${CONTROL_PORT}`));
