"use client";

import { useEffect, useState } from "react";
import { copyText } from "@/lib/docs/clipboard";
import { copyAuditClick, watchLinkedDecision } from "@/lib/proof/decision-hash";

// The two bits of /proof's Decisions section that need the browser (G4). Both are progressive enhancement: without
// JavaScript a #seq-N or #spend-N link still scrolls to its card, and the copy control is a plain link to it, named
// for what it then does. What each does on the page is in lib/proof/decision-hash.ts, where it is tested.

/** Opens the decision card the address's fragment points at, on load and on each later fragment change. */
export function OpenLinkedDecision() {
  useEffect(() => watchLinkedDecision(window, document), []);
  return null;
}

/**
 * A link to the card's audit anchor. The server renders it as "Link to this decision", a plain link; once mounted,
 * with its click handler attached, it reads "Copy audit link", and a plain click copies the page's address with that
 * fragment instead of following it. When the copy fails, it follows the link, so the address bar holds it.
 */
export function CopyAuditLink({ anchor, className }: { anchor: string; className?: string }) {
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <>
      <a
        className={className}
        href={`#${anchor}`}
        onClick={async (e) => {
          const place = {
            href: window.location.href,
            setHash: (a: string) => {
              window.location.hash = a;
            },
          };
          if ((await copyAuditClick(e, anchor, place, copyText)) === "copied") setCopied(true);
        }}
      >
        {copied ? "Copied" : mounted ? "Copy audit link" : "Link to this decision"}
      </a>
      <span className="sr-only" aria-live="polite">
        {copied ? "Audit link copied" : ""}
      </span>
    </>
  );
}
