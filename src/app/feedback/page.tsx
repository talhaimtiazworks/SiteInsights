import type { Metadata } from "next";
import { FeedbackForm } from "./feedback-form";

export const metadata: Metadata = {
  title: "Help us improve SiteInsights",
  description: "Tell us how SiteInsights is working for you — report a bug, request a feature, or share what got you results.",
  robots: { index: false, follow: false },
};

export default function FeedbackPage() {
  return (
    <div className="container max-w-3xl py-10 sm:py-14">
      <div className="ui-page-header mb-8 px-6 py-7 sm:px-8">
        <p className="eyebrow text-primary">Feedback</p>
        <h1 className="mt-2 font-display text-2xl font-bold tracking-tight sm:text-3xl">Help Us Improve SiteInsights</h1>
        <p className="mt-2 max-w-xl text-[15px] leading-6 text-secondary">
          Real notes from real users steer what gets built next. Tell us what worked, what broke, or what you wish
          existed — a couple of honest sentences are worth more than any survey. Feedback lands directly in the
          maintainer&apos;s inbox, and nothing you write is shown publicly.
        </p>
      </div>
      <FeedbackForm />
    </div>
  );
}
