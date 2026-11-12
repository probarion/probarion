"use client";

import Link from "next/link";
import { Container } from "@/components/site/Container";

// Spelled out here: this boundary loads on every page, and components/ui.tsx would bring the core package with it.
const PILL =
  "inline-flex items-center rounded-full px-4 py-2 text-sm font-medium transition-colors";

/** Shown when a page fails. What went wrong stays in the server's logs: the error's message is not for the page. */
export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  return (
    <Container>
      <div className="max-w-xl py-10">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-gold-ink">Error</p>
        <h1 className="mt-3 text-4xl font-light tracking-tight">Something went wrong.</h1>
        <p className="mt-4 text-mute">
          This page could not load. Try again, or go back to the home page.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <button
            type="button"
            className={`${PILL} bg-ink text-paper hover:bg-ink/85`}
            onClick={() => retry()}
          >
            Try again
          </button>
          <Link className={`${PILL} border border-ink/15 text-ink hover:bg-ink/5`} href="/">
            Back to the home page
          </Link>
        </div>
      </div>
    </Container>
  );
}
