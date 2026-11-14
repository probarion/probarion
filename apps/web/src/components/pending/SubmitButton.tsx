"use client";

import { useFormStatus } from "react-dom";
import { busyLabel } from "./busy-label";

/**
 * The submit button of a server-component form that keeps no client state (Discard, Remove an email, Save zero
 * retention). While its form's action runs it shows `busy`, stays focusable (aria-disabled, not disabled, so focus does
 * not drop to the page), and ignores another press: preventing the click stops a second submit, Enter in a field
 * included, as that clicks the form's default button.
 */
export function SubmitButton({
  label,
  busy,
  className,
}: {
  label: string;
  /** 1 to 4 words ending in "…", naming who acts ("Saving…"). */
  busy: string;
  className: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      aria-disabled={pending || undefined}
      onClick={(e) => {
        if (pending) e.preventDefault();
      }}
    >
      {busyLabel(label, busy, pending)}
    </button>
  );
}
