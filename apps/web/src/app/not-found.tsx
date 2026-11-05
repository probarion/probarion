import type { Metadata } from "next";
import Link from "next/link";
import { Container } from "@/components/site/Container";
import { inkPillClass, linePillClass } from "@/components/ui";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <Container>
      <div className="max-w-xl py-10">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-gold-small">Not found</p>
        <h1 className="mt-3 text-4xl font-light tracking-tight">This page does not exist.</h1>
        <p className="mt-4 text-mute">
          If you followed a link to a vault&apos;s proof page, its owner may not have made that page
          public.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Link className={inkPillClass} href="/">
            Back to the home page
          </Link>
          <Link className={linePillClass} href="/proof">
            Proof
          </Link>
        </div>
      </div>
    </Container>
  );
}
