"use client";

import { useState } from "react";
import type { TelegramState } from "@/app/console/[vault]/alerts/actions";
import { buttonClass, ExternalLink, Notice } from "@/components/ui";

/** The Telegram button of the Alerts tab: it makes the link, and shows it. The server action re-checks the role. */
export function TelegramConnect({ connect }: { connect: () => Promise<TelegramState> }) {
  const [state, setState] = useState<TelegramState | null>(null);
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      setState(await connect());
    } catch {
      setState({ ok: false, error: "The link could not be made. Try again in a minute." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <button type="button" className={buttonClass} disabled={busy} onClick={make}>
        {busy ? "Making the link…" : "Create a Telegram link"}
      </button>
      {state?.ok ? (
        <p className="mt-3 text-sm">
          Open{" "}
          <ExternalLink
            className="mono text-ink underline decoration-ink/60 break-all"
            href={state.link}
          >
            {state.link.replace("https://", "")}
          </ExternalLink>{" "}
          and press Start.
        </p>
      ) : null}
      {state !== null && !state.ok ? (
        <div className="mt-3">
          <Notice tone="bad">{state.error}</Notice>
        </div>
      ) : null}
    </div>
  );
}
