"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiClientError } from "./api";
import type { CreditsResponse } from "./types";

/** Loads the signed-in user's credit summary (and optionally ledger entries). Pass enabled=false when signed out. */
export function useCredits(enabled: boolean, limit = 1) {
  const [data, setData] = useState<CreditsResponse | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [loading, setLoading] = useState(enabled);
  const load = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    api<CreditsResponse>(`/api/credits?limit=${limit}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: ApiClientError) => setError(e))
      .finally(() => setLoading(false));
  }, [enabled, limit]);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);
  return { data, summary: data?.summary ?? null, error, loading, reload: load };
}
