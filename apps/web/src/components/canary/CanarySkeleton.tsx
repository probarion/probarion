"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LinkPending } from "@/components/pending/LinkPending";
import { SkeletonBar, SkeletonBody, SkeletonCard } from "@/components/pending/Skeleton";
import c from "@/components/site/canary.module.css";
import s from "@/components/site/site.module.css";
import { useBrowserNetwork } from "@/components/site/useBrowserNetwork";
import { linePillClass } from "@/components/ui";
import { CANARY_COPY, eyebrow, RULES_HEAD } from "@/lib/canary/copy";

const H = CANARY_COPY.head;

/**
 * What /canary and /canary/rules show while the server reads the chain and the board (app/canary/loading.tsx covers
 * both). The head is the page's own, in its classes, so the large title holds its lines and nothing under it moves when
 * the page lands: on /canary the eyebrow (with the network once the address is read), the title, the lede and the pills;
 * on the rules page its eyebrow and title. The title is the live and replay one: in code-only mode the page says
 * "code" for "contract". Below, the cards are skeleton after the 200 ms gate, and the shell holds 70% of the screen.
 * The Rules pill is a plain link: the page's `?via=` source is not known here.
 */
export function CanarySkeleton() {
  const network = useBrowserNetwork();
  const rules = usePathname()?.startsWith("/canary/rules") ?? false;
  if (rules) {
    return (
      <div aria-busy="true" className={`${s.site} ${s.wrap} ${c.page} ${c.reading} min-h-[70vh]`}>
        <p className={s.eyebrow}>{RULES_HEAD.eyebrow}</p>
        <h1 className={c.title}>{RULES_HEAD.title}</h1>
        <SkeletonBody>
          <div className="mt-7 max-w-measure">
            {[0, 1, 2, 3, 4].map((i) => (
              <SkeletonBar
                key={i}
                className={`mb-[18px] h-[50px] ${i === 4 ? "w-2/3" : "w-full"}`}
              />
            ))}
          </div>
        </SkeletonBody>
        <p className="sr-only">Loading the Canary rules…</p>
      </div>
    );
  }
  return (
    <div aria-busy="true" className={`${s.site} ${s.wrap} ${c.page} min-h-[70vh]`}>
      <header>
        {/* Until the address is read, the eyebrow both pages share, without the network. */}
        <p className={s.eyebrow}>{network === null ? RULES_HEAD.eyebrow : eyebrow(network)}</p>
        <h1 className={c.title}>{H.title}</h1>
        <p className={c.lede}>{H.lede}</p>
        <div className={c.pills}>
          <Link className={linePillClass} href="/canary/rules">
            {H.rules}
            <LinkPending />
          </Link>
          {network === "testnet" ? <span className={c.statePill}>{H.testnetPill}</span> : null}
        </div>
      </header>
      <SkeletonBody>
        <SkeletonCard bars={4} minH="min-h-[520px]" />
      </SkeletonBody>
      <p className="sr-only">Loading the Canary…</p>
    </div>
  );
}
