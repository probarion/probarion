"use client";

import { type ReactNode, useEffect, useRef } from "react";

/**
 * A <details> disclosure, so the menu opens and closes with no JavaScript at all. With it, the menu also closes when a
 * link inside it is followed (the header stays mounted across pages), on a tap outside it, and on Escape.
 */
export function PhoneMenu({
  className,
  summaryClassName,
  panelClassName,
  children,
}: {
  className?: string;
  summaryClassName?: string;
  panelClassName?: string;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const details = menu.current;
      if (!details?.open || !(event.target instanceof Element)) return;
      if (!details.contains(event.target) || event.target.closest("a") !== null) {
        details.open = false;
      }
    };
    const onKey = (event: KeyboardEvent) => {
      const details = menu.current;
      if (event.key !== "Escape" || !details?.open) return;
      details.open = false;
      details.querySelector("summary")?.focus();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <details ref={menu} className={className}>
      <summary className={summaryClassName}>Menu</summary>
      <div className={panelClassName}>{children}</div>
    </details>
  );
}
