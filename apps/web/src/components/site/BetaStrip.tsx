"use client";

import type { Network } from "@/lib/config";
import { betaStrip } from "@/lib/site/beta";
import s from "./site.module.css";
import { useBrowserNetwork } from "./useBrowserNetwork";

/**
 * What the strip says for a network, or only what is true on both while `network` is null (the server render and the
 * first paint: the network sentence is added once the address bar has been read).
 */
export function BetaStripView({ network }: { network: Network | null }) {
  const copy = betaStrip(network);
  return (
    <aside className={s.beta} aria-label="Beta notice">
      <div className={`${s.wrap} ${s.betaRow}`}>
        <span>
          <b>{copy.lead}</b> {copy.where === null ? null : `${copy.where} `}
          {copy.audit}
        </span>
        <span>
          {copy.custody} {copy.amounts}
        </span>
      </div>
    </aside>
  );
}

/** On every page: what this software is today, in words a reader sees before anything else. */
export function BetaStrip() {
  return <BetaStripView network={useBrowserNetwork()} />;
}
