import Link from "next/link";
import { ButtonLink } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="container flex max-w-xl flex-col items-center py-24 text-center">
      <p className="text-sm font-semibold text-primary">404</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-3 text-muted-foreground">The page you are looking for does not exist or has moved.</p>
      <div className="mt-8 flex gap-3">
        <ButtonLink href="/">Go home</ButtonLink>
        <ButtonLink href="/dashboard" variant="outline">Dashboard</ButtonLink>
      </div>
      <p className="mt-6 text-sm text-muted-foreground">Looking for documentation? Visit <Link href="/help" className="text-primary hover:underline">Help</Link>.</p>
    </div>
  );
}
