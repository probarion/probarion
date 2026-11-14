import Link from "next/link";
import { CLOSING } from "@/lib/site/facts";
import { NEXT_STEP } from "@/lib/site/next-step";
import { GetProbarion, TrademarkLead } from "./BuiltOn";
import { KeepRich, LIST } from "./bits";
import { NextStep } from "./NextStep";
import { Away } from "./parts";
import sh from "./ships.module.css";
import s from "./site.module.css";

/** A link of the closing: `#id` stays on this page, a path of this site opens in this tab, a full URL in a new one. */
function CloseLink({ href, label, className }: { href: string; label: string; className: string }) {
  if (href.startsWith("#")) {
    return (
      <a className={className} href={href}>
        {label}
      </a>
    );
  }
  if (href.startsWith("/")) {
    return (
      <Link className={className} href={href}>
        {label}
      </Link>
    );
  }
  return <Away className={className} href={href} label={label} />;
}

/**
 * The page's end statement, then one action per audience: the evaluation (solid), the live check the hero opens with,
 * and the source. Under them the quiet links (the docs, the spec, the demo video), where to get Probarion as a row of
 * text links, the trademark lead, and last the way into the product.
 */
export function Closing() {
  return (
    <section className={s.close}>
      <div className={s.wrap}>
        <h2 className={s.closeTitle}>
          <span>{CLOSING.line1}</span> <span className={s.gold}>{CLOSING.line2}</span>
        </h2>
        <p className={s.closeNote}>{CLOSING.sub}</p>
        <p className={s.closeNote}>
          <KeepRich text={CLOSING.live} />
        </p>
        <div className={s.cta}>
          {CLOSING.buttons.map((b) => (
            <CloseLink
              key={b.label}
              href={b.href}
              label={b.label}
              className={b.solid ? `${s.btn} ${s.solid} ${s.big}` : `${s.btn} ${s.big}`}
            />
          ))}
        </div>
        <ul className={sh.quiet} {...LIST}>
          {CLOSING.quiet.map((q) => (
            <li key={q.label}>
              <CloseLink href={q.href} label={q.label} className={`${s.link} ${sh.quietLink}`} />
            </li>
          ))}
        </ul>
        <GetProbarion />
        <TrademarkLead />
        <NextStep step={NEXT_STEP.closing} className={s.closeNext} linkClassName={s.link} />
      </div>
    </section>
  );
}
