// Diagnostic tool: a tiny round-robin HTTP load balancer that imitates a
// multi-instance (serverless) deployment by alternating requests between
// several local SiteInsight servers.
//   node scripts/round-robin-proxy.mjs 3100 3101 3102
import http from "node:http";

const [listen, ...targets] = process.argv.slice(2).map(Number);
if (!listen || targets.length < 2) {
  console.error("usage: node scripts/round-robin-proxy.mjs <listenPort> <targetPort> <targetPort> [...]");
  process.exit(1);
}
let i = 0;
http
  .createServer((req, res) => {
    const port = targets[i++ % targets.length];
    const up = http.request({ host: "127.0.0.1", port, path: req.url, method: req.method, headers: { ...req.headers, "x-forwarded-host": req.headers.host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, { ...r.headers, "x-sitelens-instance": String(port) });
      r.pipe(res);
    });
    up.on("error", () => {
      res.writeHead(502);
      res.end("upstream error");
    });
    req.pipe(up);
  })
  .listen(listen, "127.0.0.1", () => console.log(`round-robin :${listen} -> ${targets.join(", ")}`));
