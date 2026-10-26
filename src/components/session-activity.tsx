"use client";

import { signOut, useSession } from "@/lib/client/session";
import { Alert, Button } from "./ui";

/** Sign-out stays non-blocking; failures remain visible and recoverable. */
export function SessionActivity() {
  const { signingOut, error, session } = useSession();
  if (signingOut) return (
    <div role="status" aria-live="polite" aria-atomic="true" className="pointer-events-none fixed inset-x-0 top-0 z-[70]">
      <span className="sr-only">Signing you out securely…</span>
      <div aria-hidden="true" className="h-1 w-full overflow-hidden bg-primary/10">
        <div className="nav-progress-bar h-full w-1/3 rounded-r-full bg-accent" />
      </div>
    </div>
  );
  if (error && session?.user) return <div className="fixed inset-x-4 bottom-4 z-[70] mx-auto max-w-md"><Alert tone="error">{error}<Button variant="outline" size="sm" className="mt-2" onClick={() => void signOut()}>Retry sign-out</Button></Alert></div>;
  return null;
}
