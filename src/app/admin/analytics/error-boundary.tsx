"use client";

import { Component, type ReactNode } from "react";
import { Alert, Button } from "@/components/ui";

interface State {
  failed: boolean;
}

/**
 * Scoped error boundary for the private analytics dashboard. An unexpected
 * rendering failure must never escalate to the whole-app error page ("Your
 * scans are not affected") — visitors never see this area, and for the owner
 * a recoverable, self-describing state is the correct behavior. The failure
 * is logged to the browser console for the owner to report.
 */
export class AnalyticsErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[analytics] dashboard_render_failed", message.slice(0, 300));
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-16 sm:px-6">
        <Alert tone="warning" title="Statistics could not be displayed">
          Something went wrong while rendering the statistics view. Your account data is unaffected. Reloading usually resolves a transient failure; if it keeps happening, please share the error logged in the browser console.
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>Reload the dashboard</Button>
          </div>
        </Alert>
      </main>
    );
  }
}
