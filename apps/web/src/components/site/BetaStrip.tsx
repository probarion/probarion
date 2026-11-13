"use client";

import type { Network } from "@/lib/config";
import { betaStrip } from "@/lib/site/beta";
import s from "./site.module.css";
import { useBrowserNetwork } from "./useBrowserNetwork";

/**
 * What the strip says for a network, or only what is true on both while `network` is null (the server render and the
 * first paint: the network is named once the address bar has been read). Wide screens get one row; a phone gets the
 * first sentence, which opens to the rest with no JavaScript (audit P1-10). CSS shows one of the two. On testnet the
 * mainnet vault's link follows the first sentence on a wide screen, and opens the rest on a phone: a summary holds no link.
 */
export function BetaStripView({ network }: { network: Network | null }) {
  const copy = betaStrip(network);
  const first = (
    <>
      <b>{copy.bold}</b>
      {copy.first.slice(copy.bold.length)}
    </>
  );
  const mainnet =
    copy.mainnet === null ? null : (
      <>
        <a className={s.betaLink} href={copy.mainnet.href}>
          {copy.mainnet.label}
        </a>
        .
      </>
    );
  const rest = (
    <>
      {copy.custody}{" "}
      <a className={s.betaLink} href={copy.gaps.href}>
        {copy.gaps.label}
      </a>
    </>
  );
  return (
    <aside className={s.beta} aria-label="Beta notice">
      <div className={`${s.wrap} ${s.betaRow} ${s.betaWide}`}>
        <span>
          {first}
          {mainnet === null ? null : <> {mainnet}</>}
        </span>
        <span>{rest}</span>
      </div>
      <details className={`${s.wrap} ${s.betaNarrow}`}>
        <summary>{first}</summary>
        <p>
          {mainnet === null ? null : <>{mainnet} </>}
          {rest}
        </p>
      </details>
    </aside>
  );
}

/** On every page: what this software is today, in words a reader sees before anything else. */
export function BetaStrip() {
  return <BetaStripView network={useBrowserNetwork()} />;
}
