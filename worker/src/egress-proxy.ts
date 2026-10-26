import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { isIpLiteral, isPublicIp } from "../../src/lib/security/ip";

/**
 * Egress proxy that every Chromium request is forced through.
 *
 * Chromium is launched with --proxy-server pointing here, a resolver that
 * cannot resolve any hostname itself, and loopback NOT bypassed. So the only
 * way out of the browser is this proxy, which for every navigation, redirect,
 * subresource, fetch/XHR and WebSocket:
 *   1. allows only the configured ports (default 80/443/8080/8443),
 *   2. resolves the host and requires EVERY address to be public
 *      (no loopback, private, link-local/metadata, CGNAT, multicast, …),
 *   3. connects to the validated IP itself, so a second DNS answer
 *      (DNS rebinding) can never redirect the connection.
 * A regex on the URL alone is not SSRF protection; this check runs on the
 * resolved address at connection time.
 */

export type LookupAll = (host: string) => Promise<Array<{ address: string; family: number }>>;

export interface EgressPolicy {
  allowedPorts: number[];
  /** Injected for tests only. */
  lookup?: LookupAll;
  isAllowedAddress?: (ip: string) => boolean;
  /** Called for each blocked destination (host, reason). */
  onBlocked?: (host: string, reason: string) => void;
  connectTimeoutMs?: number;
}

export interface EgressProxy {
  url: string;
  port: number;
  blockedHosts: Set<string>;
  close(): Promise<void>;
}

const defaultLookup: LookupAll = (host) => dnsLookup(host, { all: true, verbatim: true });

export async function resolveAllowed(host: string, port: number, policy: EgressPolicy): Promise<{ ok: true; ip: string } | { ok: false; reason: string }> {
  if (!policy.allowedPorts.includes(port)) return { ok: false, reason: `port ${port} is not allowed` };
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!bare || bare === "localhost" || bare.endsWith(".localhost") || bare.endsWith(".local") || bare.endsWith(".internal")) return { ok: false, reason: "local host name" };
  const allowed = policy.isAllowedAddress ?? isPublicIp;
  if (isIpLiteral(bare)) return allowed(bare) ? { ok: true, ip: bare } : { ok: false, reason: "non-public IP address" };
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await (policy.lookup ?? defaultLookup)(bare);
  } catch {
    return { ok: false, reason: "DNS lookup failed" };
  }
  if (!addrs.length) return { ok: false, reason: "no DNS records" };
  if (addrs.some((a) => !allowed(a.address))) return { ok: false, reason: "resolves to a non-public address" };
  return { ok: true, ip: addrs[0].address };
}

function parseHostPort(authority: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(authority.trim());
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

export async function startEgressProxy(policy: EgressPolicy): Promise<EgressProxy> {
  const blockedHosts = new Set<string>();
  const sockets = new Set<net.Socket>();
  const block = (host: string, reason: string) => {
    blockedHosts.add(host.toLowerCase());
    policy.onBlocked?.(host, reason);
  };
  const connectTimeout = policy.connectTimeoutMs ?? 15_000;

  const server = http.createServer(async (req, res) => {
    // Plain-HTTP proxying: the request line carries an absolute URI.
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== "http:") {
      res.writeHead(400).end();
      return;
    }
    const port = target.port ? Number(target.port) : 80;
    const check = await resolveAllowed(target.hostname, port, policy);
    if (!check.ok) {
      block(target.hostname, check.reason);
      res.writeHead(403, { "content-type": "text/plain", "x-sitelens-blocked": "1" }).end("Blocked by SiteInsight egress policy");
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = http.request(
      { host: check.ip, port, method: req.method, path: `${target.pathname}${target.search}`, headers: { ...headers, host: target.host }, timeout: connectTimeout, setHost: false },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    req.pipe(upstream);
  });

  // HTTPS and WebSocket-over-TLS: CONNECT host:port tunnels.
  server.on("connect", async (req, clientSocket: net.Socket, head: Buffer) => {
    sockets.add(clientSocket);
    clientSocket.on("close", () => sockets.delete(clientSocket));
    clientSocket.on("error", () => clientSocket.destroy());
    const hp = parseHostPort(req.url ?? "", 443);
    if (!hp) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const check = await resolveAllowed(hp.host, hp.port, policy);
    if (!check.ok) {
      block(hp.host, check.reason);
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nx-sitelens-blocked: 1\r\n\r\n");
      return;
    }
    const upstream = net.connect({ host: check.ip, port: hp.port, timeout: connectTimeout });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => {
      if (clientSocket.writable) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.destroy();
    });
  });

  // Chromium tunnels ws:// through CONNECT too; any direct Upgrade request is refused.
  server.on("upgrade", (_req, socket: net.Socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    blockedHosts,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
