import type { ReactNode } from "react";
import c from "@/components/site/canary.module.css";
import type { Tone } from "@/components/ui";

const TONE_CLASS: Record<Tone, string> = {
  good: c.ok,
  bad: c.fail,
  warn: c.wait,
  neutral: c.plan,
  info: c.plan,
};

/** A small status label of the Canary pages. The tone is a colour and also an attribute, so that a test can read it. */
export function Chip({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`${c.chip} ${TONE_CLASS[tone]}`} data-tone={tone}>
      {children}
    </span>
  );
}
