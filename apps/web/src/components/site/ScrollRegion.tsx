"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * A panel that may scroll sideways on a narrow screen. The role and label say what it holds. While it really scrolls it
 * takes keyboard focus, or a keyboard user could not scroll it. With no JavaScript nothing can measure it, so it stays
 * a tab stop.
 */
export function ScrollRegion({
  label,
  className,
  children,
}: {
  label: string;
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
      tabIndex={scrolls ? 0 : undefined}
    >
      {children}
    </section>
  );
}
