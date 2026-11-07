import Link from "next/link";
import c from "@/components/site/canary.module.css";
import { brandCardClass } from "@/components/ui";
import { CANARY_COPY, runsOn } from "@/lib/canary/copy";
import type { Network } from "@/lib/config";

/**
 * "Paid to an attacker: 0" is not a measurement and is not drawn as one: nothing counts it, so the card states what is
 * true by construction, and links to where the site shows that a spend request has no address field.
 */
export function ByConstructionCard() {
  const A = CANARY_COPY.attacker;
  return (
    <section className={brandCardClass}>
      <h2 className={c.cardTitle}>{A.title}</h2>
      <p>{A.body}</p>
      <p className={c.line}>
        <Link className={c.link} href={A.href}>
          {A.link}
        </Link>
      </p>
    </section>
  );
}

function FreysaCard() {
  const { freysa } = CANARY_COPY;
  return (
    <section className={brandCardClass}>
      <h2 className={c.cardTitle}>{freysa.title}</h2>
      <p>{freysa.body}</p>
    </section>
  );
}

/**
 * Two cards side by side (stacked on a phone) under the live page: why this is not the Freysa game, and what this page
 * does not show, the ledger among it.
 */
export function SideCards({ network }: { network: Network }) {
  const { limits } = CANARY_COPY;
  return (
    <div className={c.pair}>
      <FreysaCard />
      <section className={brandCardClass}>
        <h2 className={c.cardTitle}>{limits.title}</h2>
        <p>
          {limits.ipv6} {limits.caps} {limits.ledger} {runsOn(network)}
        </p>
      </section>
    </div>
  );
}

/** The two cards of the replay: both hold whether or not the Canary is live, and neither describes a live page. */
export function ReplayCards() {
  return (
    <div className={c.pair}>
      <ByConstructionCard />
      <FreysaCard />
    </div>
  );
}
