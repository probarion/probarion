"use client";

import { useEffect, useRef, useState } from "react";
import { MIN_SHOW_MS, SHOW_DELAY_MS } from "@/lib/ui/pending";

// The loading system's two timers. They use useState, useEffect and useRef only, so a test can run them, and the
// components that use them, as plain functions (test/fixtures/mini-react.ts). A busy button needs neither: its delay is
// CSS (busyLabel), and its label and ARIA change at once.

/**
 * True from `delayMs` after `on` turns true; once true it stays at least `minMs`, so it does not flicker. For an
 * indicator that REPLACES content (the live check's "Asking" headline): a button label or a result is never held back.
 */
export function useDelayedFlag(
  on: boolean,
  delayMs: number = SHOW_DELAY_MS,
  minMs: number = MIN_SHOW_MS,
): boolean {
  const [shown, setShown] = useState(false);
  const since = useRef(0);
  useEffect(() => {
    if (on && !shown) {
      const t = setTimeout(() => {
        since.current = Date.now();
        setShown(true);
      }, delayMs);
      return () => clearTimeout(t);
    }
    if (!on && shown) {
      const left = minMs - (Date.now() - since.current);
      if (left <= 0) {
        setShown(false);
        return;
      }
      const t = setTimeout(() => setShown(false), left);
      return () => clearTimeout(t);
    }
  }, [on, shown, delayMs, minMs]);
  return shown;
}

/**
 * Milliseconds since `active` turned true, ticking once a second; 0 while inactive. A new `restartKey` (a string or a
 * number, such as the phase) starts it again from 0, and the render that brings the new key already reads 0, so a phase
 * does not show the last phase's time or its slow hint.
 */
export function useElapsed(active: boolean, restartKey?: unknown): number {
  const [tick, setTick] = useState<{ key: unknown; at: number; now: number } | null>(null);
  useEffect(() => {
    if (!active) {
      setTick(null);
      return;
    }
    const at = Date.now();
    setTick({ key: restartKey, at, now: at });
    const id = setInterval(() => setTick({ key: restartKey, at, now: Date.now() }), 1000);
    return () => clearInterval(id);
  }, [active, restartKey]);
  return active && tick !== null && Object.is(tick.key, restartKey) ? tick.now - tick.at : 0;
}
