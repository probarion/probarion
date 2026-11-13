"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * A panel that may scroll sideways on a narrow screen. The role and label say what it holds. While it really scrolls it
 * takes keyboard focus, or a keyboard user could not scroll it. With no JavaScript nothing can measure it, so it stays
 * a tab stop. A panel under a visible caption takes its name from it (`labelledBy`, the caption's id), so a screen
 * reader does not say the same words twice.
 */
export function ScrollRegion({
  label,
  labelledBy,
  className,
  children,
}: ({ label: string; labelledBy?: undefined } | { label?: undefined; labelledBy: string }) & {
  className?: string;
  children: ReactNode;
}) {
  const region = useRef<HTMLElement>(null);
  const [scrolls, setScrolls] = useState(true);
  useEffect(() => {
    const el = region.current;
    if (el === null) return;
    const measure = () => setScrolls(el.scrollWidth > el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // A child that grows (a row note, a late font) can start the scroll with no change to the panel's own box.
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, []);
  return (
    <section
      ref={region}
      className={className}
      aria-label={label}
      aria-labelledby={labelledBy}
      tabIndex={scrolls ? 0 : undefined}
      onFocus={(event) => {
        // Chrome leaves a focused element where it is while any part of it shows, so a link mostly outside the panel
        // would keep most of its focus ring out of sight. A keyboard focus brings it in; a click does not, so the panel
        // does not move under the pointer.
        const target = event.target;
        if (target !== event.currentTarget && target.matches(":focus-visible"))
          target.scrollIntoView({ block: "nearest", inline: "nearest" });
      }}
    >
      {children}
    </section>
  );
}
