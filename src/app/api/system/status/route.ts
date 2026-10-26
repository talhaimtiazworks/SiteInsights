import { getConfig } from "@/lib/config/env";
import { ok, route } from "@/lib/http/api";
import { backgroundMode } from "@/lib/services/background";
import { storageStatus } from "@/lib/services/diagnostics";
import { aiProviderSupport, availableChecks } from "@/lib/services/scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public, non-sensitive configuration status (no values, no secrets). */
export const GET = route(async () => {
  const cfg = getConfig();
  return ok({
    app: "SiteInsights",
    version: "0.4.0",
    storage: await storageStatus(),
    ai: { byok: true, supportedProviders: aiProviderSupport().map((p) => ({ id: p.id, label: p.label })) },
    features: (() => {
      const a = availableChecks();
      return { browserRendering: a.browser, browserPagesPerScan: a.browserPages, accessibility: a.accessibility, performance: a.performance, performanceStrategies: a.performanceStrategies };
    })(),
    background: backgroundMode(),
    accounts: cfg.auth.supabase.authEnabled,
    configWarnings: [...cfg.warnings],
    // Variable names and fixes only; values are never included.
    configIssues: cfg.configIssues,
  });
});
