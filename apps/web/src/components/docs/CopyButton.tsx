"use client";

import { useEffect, useState } from "react";
import { copyText } from "@/lib/docs/clipboard";

/**
 * Copies `text`. It is hidden until JavaScript runs, because without it the button could do nothing. The outcome is
 * announced in a status region, and the label goes back after two seconds.
 */
export function CopyButton({
  text,
  label = "Copy",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => setReady(true), []);
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  const shown = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;
  return (
    <>
      <button
        type="button"
        className={className}
        hidden={!ready}
        onClick={async () => setState((await copyText(text)) ? "copied" : "failed")}
      >
        {shown}
      </button>
      <span role="status" className="sr-only">
        {state === "idle" ? "" : shown}
      </span>
    </>
  );
}
