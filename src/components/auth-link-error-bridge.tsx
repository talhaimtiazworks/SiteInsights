"use client";

import { useEffect } from "react";
import { authLinkErrorTarget } from "@/lib/client/auth-link-error";

/** Sends visitors who arrive with a Supabase auth-error fragment to the branded sign-in message (see authLinkErrorTarget). */
export function AuthLinkErrorBridge() {
  useEffect(() => {
    const target = authLinkErrorTarget(window.location.hash, window.location.search);
    if (target) window.location.replace(target);
  }, []);
  return null;
}
