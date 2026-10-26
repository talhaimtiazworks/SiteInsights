import type { Metadata } from "next";
import { InvitationLandingClient } from "./invitation-landing-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Team invitation", robots: { index: false, follow: false } };

/** Public review page for a tokenized invitation; joining still requires an explicit authenticated response. */
export default function TeamInvitationPage() {
  return <InvitationLandingClient />;
}
