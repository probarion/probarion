"use client";

import { useEffect, useState } from "react";
import { copyText } from "@/lib/docs/clipboard";
import { auditUrl, openLinkedDecision } from "@/lib/proof/decision-hash";

// The two bits of /proof's Decisions section that need the browser (G4). Both are progressive enhancement: without
// JavaScript a #seq-N or #spend-N link still scrolls to its card, and "Copy audit link" is a plain link to it.

/** Opens the decision card the address's fragment points at, on load and on each later fragment change. */
export function OpenLinkedDecision() {
  useEffect(() => {
    const open = () => {
      openLinkedDecision(document, window.location.hash);
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
  return null;
}

/**
 * A link to the card's audit anchor. With JavaScript and a clipboard, a plain click copies the page's address with
 * that fragment instead of following it; when the copy fails, it follows the link, so the address bar holds it.
 */
export function CopyAuditLink({ anchor, className }: { anchor: string; className?: string }) {
  const [copied, setCopied] = useState(false);
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
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          if (await copyText(auditUrl(window.location.href, anchor))) setCopied(true);
          else window.location.hash = anchor;
        }}
      >
        {copied ? "Copied" : "Copy audit link"}
      </a>
      <span className="sr-only" aria-live="polite">
        {copied ? "Audit link copied" : ""}
      </span>
    </>
  );
}
