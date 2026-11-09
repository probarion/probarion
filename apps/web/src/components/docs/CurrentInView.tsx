"use client";

import { useEffect, useRef } from "react";

/** A box's top and bottom edges, as getBoundingClientRect gives them. */
export interface Edges {
  top: number;
  bottom: number;
}

/**
 * The scrollTop that centres the link in its scroll box, or null when the link is already in full
 * view: a link the reader can see never moves.
 */
export function scrollTopFor(box: Edges, link: Edges, scrollTop: number): number | null {
  if (link.top >= box.top && link.bottom <= box.bottom) return null;
  const room = box.bottom - box.top - (link.bottom - link.top);
  return Math.max(0, Math.round(scrollTop + link.top - box.top - room / 2));
}

/** The nearest ancestor that scrolls up and down, below the page itself; null when there is none. */
function scrollBox(el: Element): HTMLElement | null {
  for (let at = el.parentElement; at !== null; at = at.parentElement) {
    if (at === document.body || at === document.documentElement) return null;
    const { overflowY } = getComputedStyle(at);
    if (overflowY === "auto" || overflowY === "scroll") return at;
  }
  return null;
}

/**
 * Brings the sidebar's current link into view inside the sidebar's own box: on load, when the page
 * changes and when the phone drawer opens. It sets that box's scrollTop, never scrollIntoView, so
 * the window does not scroll. It renders a hidden span in the nav it works on.
 */
export function CurrentInView({ current }: { current: string | null }) {
  const mark = useRef<HTMLSpanElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: it runs again when the page changes.
  useEffect(() => {
    const nav = mark.current?.closest("nav");
    if (!nav) return;
    const show = () => {
      const link = nav.querySelector('[aria-current="page"]');
      const box = link === null ? null : scrollBox(link);
      if (link === null || box === null) return;
      const top = scrollTopFor(
        box.getBoundingClientRect(),
        link.getBoundingClientRect(),
        box.scrollTop,
      );
      if (top !== null) box.scrollTop = top;
    };
    show();
    const drawer = nav.closest("details");
    const onToggle = () => {
      if (drawer?.open) show();
    };
    drawer?.addEventListener("toggle", onToggle);
    return () => drawer?.removeEventListener("toggle", onToggle);
  }, [current]);
  return <span ref={mark} hidden />;
}
