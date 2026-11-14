"use client";

import { useTransition } from "react";
import { busyLabel } from "@/components/pending/busy-label";
import { RouteLink } from "@/components/RouteLink";
import { buttonClass, lineButtonClass } from "@/components/ui";
import { TRY_AGAIN_BUSY, TRY_AGAIN_LABEL } from "@/lib/ui/pending";

/**
 * A console page that failed. It sits under the console's layout, so the "Signed in as" line stays (app/error.tsx would
 * replace it). It claims nothing about the chain or the database: what went wrong stays in the server's logs, and
 * something the visitor had just signed or saved may or may not have gone through, so it sends them to look before they
 * do it again. Try again is Next's retry, which reads the page again and draws it; the button says so until the page is
 * back, and a second press while it runs does nothing.
 */
export default function ConsoleError({ retry }: { error: unknown; retry: () => void }) {
  const [trying, startTrying] = useTransition();
  return (
    <div className="max-w-xl py-10">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-gold-ink">Console</p>
      <h1 className="mt-3 text-4xl font-light tracking-tight">This page could not load.</h1>
      <p className="mt-4 text-mute">
        Try again. If you had just signed or saved something, check its result on its page or on the
        explorer before you do it again.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass}
          aria-disabled={trying || undefined}
          onClick={() => {
            if (trying) return;
            startTrying(() => retry());
          }}
        >
          {busyLabel(TRY_AGAIN_LABEL, TRY_AGAIN_BUSY, trying)}
        </button>
        <RouteLink route="/console" className={lineButtonClass}>
          Your vaults
        </RouteLink>
      </div>
    </div>
  );
}
