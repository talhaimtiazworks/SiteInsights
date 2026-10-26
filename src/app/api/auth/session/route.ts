import type { NextRequest } from "next/server";
import { getAuthState } from "@/lib/auth/server";
import { maybeAccountRepository } from "@/lib/db";
import { ok, route } from "@/lib/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in user (validated server-side) for the header/account menu. Never returns tokens. */
export const GET = route(async (req: NextRequest) => {
  const s = await getAuthState(req);
  let settings: { theme: string; defaultBrowser: boolean; defaultPerformance: boolean } | null = null;
  if (s.status === "signed_in") {
    const accounts = maybeAccountRepository();
    if (accounts) {
      settings = await accounts.getUserSettings(`user:${s.user.id}`)
        .then((x) => ({ theme: x.theme, defaultBrowser: x.defaultBrowser, defaultPerformance: x.defaultPerformance }))
        .catch(() => null);
    }
  }
  const res = ok({
    theme: settings?.theme ?? null,
    settings,
    status: s.status,
    accountsEnabled: s.status !== "disabled",
    user: s.status === "signed_in" ? { id: s.user.id, email: s.user.email, displayName: s.user.displayName, avatarUrl: s.user.avatarUrl, isSso: s.user.isSso } : null,
  });
  res.headers.set("cache-control", "private, no-store");
  return res;
});
