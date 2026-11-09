import type { ReactNode } from "react";
import { lineButtonClass } from "@/components/ui";

/** What a click on the offer did: a fill to check, or a load that went wrong. */
export interface SampleNote {
  text: string;
  failed?: boolean;
}

/** The look of a plain text link in the offer: 44px tall, as the kit's buttons are. */
export const sampleLinkClass =
  "inline-flex min-h-11 items-center text-sm text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink";

/**
 * "Trying it out?": a testnet form's offer to fill itself from the sample kit (site audit P1-8). The button is the
 * outline pill, beside anything else the offer needs (a download link); `note` says what the click did. The status
 * region is on the page from the start, so a screen reader announces the first note.
 */
export function SampleOffer({
  text,
  label,
  onUse,
  busy = false,
  note,
  children,
}: {
  text: string;
  label: string;
  onUse: () => void;
  busy?: boolean;
  note?: SampleNote | null;
  children?: ReactNode;
}) {
  return (
    <div className="mb-4 rounded-2xl border border-line bg-paper p-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div>
          <p className="text-sm font-medium text-ink">Trying it out?</p>
          <p className="text-sm text-mute">{text}</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button type="button" className={lineButtonClass} onClick={onUse} disabled={busy}>
            {busy ? "Loading the sample…" : label}
          </button>
          {children}
        </div>
      </div>
      <div role="status">
        {note ? (
          <p className={`mt-2 text-sm ${note.failed ? "text-bad" : "text-mute"}`}>{note.text}</p>
        ) : null}
      </div>
    </div>
  );
}
