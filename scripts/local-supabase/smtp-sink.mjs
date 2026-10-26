/**
 * Development/test SMTP sink for a local Supabase Auth (GoTrue) server.
 * - SMTP on SMTP_PORT (default 2500): accepts every message, stores it in memory.
 * - HTTP on HTTP_PORT (default 2501):
 *     GET    /messages              → [{ id, to, from, subject, html, contentTypes, size, receivedAt }]
 *     DELETE /messages              → clears the inbox
 *     GET    /templates/<name>.html → serves supabase/templates/<name>.html (GoTrue fetches templates by URL)
 * Never use in production.
 */
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SMTP_PORT = Number(process.env.SMTP_PORT ?? 2500);
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 2501);
// EMAIL_TEMPLATES_DIR: e.g. a copy built with `build-templates.mjs --app-url http://127.0.0.1:3000 --out …`.
const templatesDir = path.resolve(process.env.EMAIL_TEMPLATES_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../../supabase/templates"));
const inbox = [];
let seq = 0;

function decodeQuotedPrintable(s) {
  // Decode to bytes first, then UTF-8 (byte-wise fromCharCode would turn "—" into "â€”").
  const bytes = [];
  const t = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "=" && /^[0-9A-F]{2}$/i.test(t.slice(i + 1, i + 3))) { bytes.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(...Buffer.from(t[i], "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}
function parseMessage(raw, rcpt) {
  const [head, ...rest] = raw.split(/\r?\n\r?\n/);
  let body = rest.join("\n\n");
  const subject = /^Subject: (.*)$/im.exec(head)?.[1]?.trim() ?? "";
  if (/quoted-printable/i.test(raw)) body = decodeQuotedPrintable(body);
  if (/Content-Transfer-Encoding: base64/i.test(raw)) {
    const b64 = body.replace(/--[^\n]*\n?/g, "").replace(/Content-[^\n]*\n/gi, "").replace(/\s+/g, "");
    try { body = Buffer.from(b64, "base64").toString("utf8"); } catch { /* keep raw */ }
  }
  // MIME parts present (e.g. ["text/html"] or ["multipart/alternative","text/plain","text/html"]) and sender, for template tests.
  const contentTypes = [...raw.matchAll(/^Content-Type:\s*([a-z]+\/[a-z0-9.+-]+)/gim)].map((m) => m[1].toLowerCase());
  const from = /^From: (.*)$/im.exec(head)?.[1]?.trim() ?? "";
  return { id: ++seq, to: rcpt, from, subject, html: body.replace(/&amp;/g, "&"), contentTypes, size: raw.length, receivedAt: new Date().toISOString() };
}

net.createServer((sock) => {
  let buf = "", inData = false, data = "", rcpt = [];
  const send = (l) => sock.write(l + "\r\n");
  send("220 sitelens-smtp-sink ready");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (inData) {
        if (line === ".") { inData = false; inbox.push(parseMessage(data, rcpt)); data = ""; rcpt = []; send("250 OK queued"); }
        else data += (line.startsWith("..") ? line.slice(1) : line) + "\r\n";
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO") { send("250-sitelens-smtp-sink"); send("250-AUTH PLAIN LOGIN"); send("250 8BITMIME"); }
      else if (cmd === "HELO") send("250 sitelens-smtp-sink");
      else if (cmd === "AUTH") send("235 Authentication successful");
      else if (cmd === "MAIL") send("250 OK");
      else if (cmd === "RCPT") { rcpt.push((/<([^>]+)>/.exec(line)?.[1] ?? "").toLowerCase()); send("250 OK"); }
      else if (cmd === "DATA") { inData = true; send("354 End data with <CR><LF>.<CR><LF>"); }
      else if (cmd === "QUIT") { send("221 Bye"); sock.end(); }
      else send("250 OK");
    }
  });
  sock.on("error", () => {});
}).listen(SMTP_PORT, "127.0.0.1", () => console.log(`[smtp-sink] SMTP on 127.0.0.1:${SMTP_PORT}`));

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/messages" && req.method === "GET") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(inbox));
  if (url.pathname === "/messages" && req.method === "DELETE") { inbox.length = 0; return void res.writeHead(204).end(); }
  const m = /^\/templates\/([a-z_]+\.html)$/.exec(url.pathname);
  if (m) {
    try { return void res.writeHead(200, { "content-type": "text/html" }).end(await readFile(path.join(templatesDir, m[1]))); }
    catch { return void res.writeHead(404).end(); }
  }
  res.writeHead(404).end();
}).listen(HTTP_PORT, "127.0.0.1", () => console.log(`[smtp-sink] HTTP on 127.0.0.1:${HTTP_PORT}`));
