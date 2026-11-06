"use client";

import type { Network } from "@/lib/config";
import type { NetworkSwitchModel } from "@/lib/site/network";
import s from "./site.module.css";
import { useNetworkSwitch } from "./useBrowserNetwork";

const NAME: Record<Network, string> = { mainnet: "Mainnet", testnet: "Testnet" };

/**
 * The switch, as the model describes it. `pill` is the header's pair, "Testnet | Mainnet" in that order whichever is
 * current: the current network is filled and is not a link, the other is a quiet link to its address with a small
 * up-right arrow. `menu` is the last row of the phone menu: "Network: Testnet" and an accent link "Mainnet ↗".
 * With no model (before mount, or the other network is not served) there is nothing to show.
 */
export function NetworkSwitchView({
  model,
  variant,
}: {
  model: NetworkSwitchModel | null;
  variant: "pill" | "menu";
}) {
  if (model === null) return null;
  if (variant === "menu") {
    return (
      <div className={s.menuNetwork}>
        <span>
          Network: <b className={s.menuNetworkName}>{NAME[model.current]}</b>
        </span>
        <a className={s.menuNetworkLink} href={model.href}>
          {NAME[model.other]} <span aria-hidden="true">↗</span>
        </a>
      </div>
    );
  }
  return (
    <ul className={s.netSwitch} aria-label="Network">
      {(["testnet", "mainnet"] as const).map((network) => (
        <li key={network}>
          {network === model.current ? (
            <span className={`${s.netPill} ${s.netPillCurrent}`} aria-current="true">
              {NAME[network]}
            </span>
          ) : (
            <a className={s.netPill} href={model.href}>
              {NAME[network]} <span aria-hidden="true">↗</span>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The switch for the page it is on. It appears after mount, and only when the other network is served. */
export function NetworkSwitch({ variant }: { variant: "pill" | "menu" }) {
  return <NetworkSwitchView model={useNetworkSwitch()} variant={variant} />;
}
