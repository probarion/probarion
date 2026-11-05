import type { Network } from "@/lib/config";
import { betaStrip } from "@/lib/site/facts";
import s from "./site.module.css";

/** On every page: what this software is today, in words a reader sees before anything else. */
export function BetaStrip({ network }: { network: Network }) {
  const copy = betaStrip(network);
  return (
    <aside className={s.beta} aria-label="Beta notice">
      <div className={`${s.wrap} ${s.betaRow}`}>
        <span>
          <b>{copy.lead}</b> {copy.where} {copy.audit}
        </span>
        <span>
          {copy.custody} {copy.amounts}
        </span>
      </div>
    </aside>
  );
}
