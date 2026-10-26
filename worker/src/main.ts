import { createWorkerServer } from "./app";
import { createRenderer } from "./render";

/**
 * SiteInsight browser worker.
 *
 * Environment:
 *   WORKER_TOKEN        required, ≥ 24 chars; the app sends it as BROWSER_WORKER_TOKEN
 *   PORT                default 8080
 *   WORKER_CONCURRENCY  parallel renders (default 2; each uses ~300–600 MB RAM)
 *   CHROMIUM_PATH       optional Chromium executable (the Docker image ships one)
 */
const token = process.env.WORKER_TOKEN ?? "";
if (token.length < 24) {
  console.error("WORKER_TOKEN must be set to a random string of at least 24 characters.");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8080);
const capacity = Math.min(8, Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 2) || 2));
const renderer = createRenderer({ executablePath: process.env.CHROMIUM_PATH || undefined });
const server = createWorkerServer({
  token,
  capacity,
  renderer: renderer.render,
  browserVersion: renderer.browserVersion,
  // Logs never contain URLs, page content or tokens.
  log: (m) => console.log(`[worker] ${m}`),
});
server.listen(port, "0.0.0.0", () => console.log(`[worker] listening on :${port} (capacity ${capacity})`));
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
