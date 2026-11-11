"use client";

import { useEffect, useId, useRef, useState } from "react";
import c from "@/components/site/canary.module.css";
import { CANARY_COPY } from "@/lib/canary/copy";

const F = CANARY_COPY.form;

/**
 * Whether the tooltip shows: `auto` while the pointer is over the pill or the tooltip (CSS, where there is hover),
 * `open` while the pill has the focus or after a tap, `closed` after Escape until the pill loses the focus.
 */
export type TipState = "auto" | "open" | "closed";

/**
 * The "Raw mode on" pill, with what raw mode does in a tooltip. The pill is a button, so the keyboard reaches it, and the
 * tooltip is its description (aria-describedby): a screen reader reads it with the button even while it is hidden. It
 * shows on hover, on focus and after a tap (a phone has no hover); Escape hides it without moving the focus, and a press
 * anywhere else hides it after a tap. Pressing the pill does nothing else.
 */
export function RawModeTip() {
  const id = useId();
  const [tip, setTip] = useState<TipState>("auto");
  const wrap = useRef<HTMLSpanElement | null>(null);

  // After a tap the pill may not have the focus (Safari on iOS gives none), so a press outside closes the tooltip.
  useEffect(() => {
    if (tip !== "open" || typeof document === "undefined") return;
    const away = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !wrap.current?.contains(e.target)) setTip("auto");
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [tip]);

  return (
    <span ref={wrap} className={c.tipWrap}>
      <button
        type="button"
        className={c.tipButton}
        aria-describedby={`${id}-tip`}
        onFocus={() => setTip("open")}
        onBlur={() => setTip("auto")}
        onClick={() => setTip("open")}
        onKeyDown={(e) => {
          if (e.key === "Escape") setTip("closed");
        }}
      >
        {F.rawOn}
        <span className={c.tipMark} aria-hidden="true">
          ?
        </span>
      </button>
      <span role="tooltip" id={`${id}-tip`} className={c.tip} data-state={tip}>
        {F.rawTip}
      </span>
    </span>
  );
}
