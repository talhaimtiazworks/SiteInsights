"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Alert } from "./ui";

export interface SystemStatus {
  storage: { mode: "postgres" | "memory" | "unconfigured"; persistent: boolean; ready: boolean };
  ai: { anyConfigured: boolean; defaultProvider: string | null };
  features: { browserRendering: boolean; browserPagesPerScan: number; accessibility: boolean; performance: boolean; performanceStrategies: Array<"mobile" | "desktop"> };
  background?: "full" | "limited" | "off";
  accounts?: boolean;
}

let cached: Promise<SystemStatus | null> | null = null;
/** Shared, de-duplicated status request for the current page view. */
export function loadSystemStatus(): Promise<SystemStatus | null> {
  cached ??= api<SystemStatus>("/api/system/status").catch(() => {
    cached = null;
    return null;
  });
  return cached;
}

export function useSystemStatus() {
  const [s, setS] = useState<SystemStatus | null>(null);
  useEffect(() => {
    let live = true;
    loadSystemStatus().then((v) => live && setS(v));
    return () => {
      live = false;
    };
  }, []);
  return s;
}

/** Notices users genuinely need: audits unavailable, or audits not kept permanently. */
export function SystemNotice({ showAi = false }: { showAi?: boolean }) {
  const s = useSystemStatus();
  if (!s) return null;
  return (
    <div className="space-y-3">
      {s.storage.mode === "unconfigured" ? (
        <Alert tone="error" title="Audits are unavailable on this deployment">
          No database is configured, so audits can&apos;t be saved. If you run this site, set <code className="font-mono">DATABASE_URL</code> and redeploy.{" "}
          <Link href="/help#storage" className="underline">Setup help</Link>
        </Alert>
      ) : null}
      {s.storage.mode === "memory" ? (
        <Alert tone="warning" title="Audits are kept temporarily">
          This server has no database, so audit history is cleared when it restarts. <Link href="/help#storage" className="underline">Learn more</Link>
        </Alert>
      ) : null}
      {showAi && !s.ai.anyConfigured ? (
        <Alert tone="info" title="AI explanations aren't available yet">
          Audits and all standard checks work normally. AI explanations appear once an AI provider is configured.
        </Alert>
      ) : null}
    </div>
  );
}
