/**
 * Route handlers run inside the Next.js server runtime, which installs a few
 * globals on older Node versions (e.g. WebSocket on Node 20, required by
 * @supabase/supabase-js). Load the same baseline so tests match production.
 */
import "next/dist/server/node-environment-baseline";
