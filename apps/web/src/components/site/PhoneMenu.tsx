"use client";

import { type ReactNode, useEffect, useRef } from "react";

/**
 * A <details> disclosure, so the menu opens and closes with no JavaScript at all. With it, the menu also closes when a
 * link inside it is followed (the header stays mounted across pages), on a tap outside it, on Escape, and when focus
 * moves out of it. `label` names the summary (Menu by default).
 */
export function PhoneMenu({
  label = "Menu",
  className,
  summaryClassName,
  panelClassName,
  children,
}: {
  label?: string;
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
    const onFocusOut = (event: FocusEvent) => {
      const details = menu.current;
      const from = event.target;
      const to = event.relatedTarget;
      if (!details?.open || !(from instanceof Node) || !(to instanceof Node)) return;
      if (details.contains(from) && !details.contains(to)) details.open = false;
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
  return (
    <details ref={menu} className={className}>
      <summary className={summaryClassName}>{label}</summary>
      <div className={panelClassName}>{children}</div>
    </details>
  );
}
