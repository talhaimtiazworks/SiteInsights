"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiClientError } from "./api";
import type { AccountResponse } from "./types";
import { toSignIn } from "@/lib/client/navigate";

/** Loads /api/account; redirects to sign-in when the session has expired. */
export function useAccount() {
  const [data, setData] = useState<AccountResponse | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    api<AccountResponse>("/api/account")
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: ApiClientError) => {
        if (e.status === 401) {
          toSignIn("expired");
          return;
        }
        setError(e);
      })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);
  return { data, error, loading, reload: load, setData };
}
