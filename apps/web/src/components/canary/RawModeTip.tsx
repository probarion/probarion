"use client";

import { useEffect, useId, useRef, useState } from "react";
import c from "@/components/site/canary.module.css";
import { CANARY_COPY } from "@/lib/canary/copy";

const F = CANARY_COPY.form;

/**
 * Whether the tooltip shows: `auto` while the pointer is over the pill or the tooltip (CSS, where there is hover),
 * `open` while the pill has the focus or after a tap, `closed` after Escape until the pill loses the focus or the
 * pointer leaves.
 */
export type TipState = "auto" | "open" | "closed";

/**
 * The "Raw mode on" pill, with what raw mode does in a tooltip. The pill is a button, so the keyboard reaches it, and the
 * tooltip is its description (aria-describedby): a screen reader reads it with the button even while it is hidden. It
 * shows on hover, on focus and after a tap (a phone has no hover); Escape hides it without moving the focus or the
 * pointer, wherever the focus is (WCAG 1.4.13), and a press anywhere else hides it after a tap. Pressing the pill does
 * nothing else.
 */
export function RawModeTip() {
  const id = useId();
  const [tip, setTip] = useState<TipState>("auto");
  // Whether the pointer is over the pill or the tooltip, so that Escape can hide a tooltip that hover alone shows.
  const [hovered, setHovered] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);

  // While the tooltip can show (under the pointer, or open), Escape hides it, even with the focus elsewhere.
  useEffect(() => {
    if ((!hovered && tip !== "open") || typeof document === "undefined") return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTip("closed");
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [hovered, tip]);

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
    <span
      ref={wrap}
      className={c.tipWrap}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        setHovered(false);
        // Hover can show it again next time: Escape hid it for this visit of the pointer only.
        setTip((t) => (t === "closed" ? "auto" : t));
      }}
    >
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
