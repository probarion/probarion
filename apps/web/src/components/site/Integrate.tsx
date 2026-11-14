import Link from "next/link";
import { CopyButton } from "@/components/docs/CopyButton";
import { RouteLink } from "@/components/RouteLink";
import { INTEGRATE } from "@/lib/site/facts";
import { KeepRich, LIST, Mark } from "./bits";
import { ConsoleShot } from "./ConsoleShots";
import m from "./integrate.module.css";
import { Away, StatusPill } from "./parts";
import { LandingSection } from "./SectionHead";
import s from "./site.module.css";

/** The uses' list, an anchor of its own. */
export const USES_ID = "integrate-uses";

const NBSP = " ";

type Use = (typeof INTEGRATE.who)[number];

/** A stamp's tone: the page's pairs, ok on its tint for paid and bad on its tint for refused. */
const STAMP: Readonly<Record<Use["stamps"][number]["tone"], string | undefined>> = {
  paid: m.stampPaid,
  refused: m.stampRefused,
};

/**
 * A use's one link to its record: a place on this page (↓), a page of this site (→), or a file elsewhere, in a new tab
 * with the shared arrow (parts.tsx Away). The arrow is glued to the last word.
 */
function Evidence({ link }: { link: Use["evidence"] }) {
  const className = `${s.link} ${m.ev}`;
  if (link.href.startsWith("#")) {
    return (
      <a className={className} href={link.href}>
        {link.label}
        {NBSP}
        <span aria-hidden="true">↓</span>
      </a>
    );
  }
  if (link.href.startsWith("/")) {
    return (
      <Link className={className} href={link.href}>
        {link.label}
        {NBSP}
        <span aria-hidden="true">→</span>
      </Link>
    );
  }
  return <Away className={className} href={link.href} label={link.label} />;
}

/**
 * One use as a card: its network over its title, what it is, what the mandate controls in it, then its outcome under a
 * hairline, stamped in its tone, with the link to its record. Each stamp ends in a full stop for a screen reader, so
 * that two stamps and the sentence after them are read apart.
 */
function UseCard({ use }: { use: Use }) {
  return (
    <li className={m.use}>
      <hgroup className={m.useHead}>
        <p className={use.network === "Mainnet" ? `${m.net} ${m.netMain}` : m.net}>{use.network}</p>
        <h3 className={m.useTitle}>{use.title}</h3>
      </hgroup>
      <p className={m.useBody}>
        <KeepRich text={use.body} />
      </p>
      <p className={m.chip}>
        <span className={m.chipLabel}>
          {INTEGRATE.controlsLabel}
          <span className="sr-only">:</span>
        </span>{" "}
        {use.control}
      </p>
      <div className={m.outcome}>
        <p className={m.stamps}>
          {use.stamps.map((x) => (
            <span key={x.label} className={`${m.stamp} ${STAMP[x.tone]}`}>
              <Mark tone={x.tone} />
              {x.label}
              <span className="sr-only">.</span>
            </span>
          ))}
        </p>
        <p className={m.outcomeText}>
          <KeepRich text={use.outcome} />
        </p>
        <Evidence link={use.evidence} />
      </div>
    </li>
  );
}

/** The SDK's install line, as the SDK README has it, with a copy button (hidden until the script runs), then the quickstart. */
function Install() {
  const x = INTEGRATE.install;
  return (
    <div className={m.install}>
      <div className={m.cmd}>
        <code>
          <span className={m.prompt} aria-hidden="true">
            ${" "}
          </span>
          {x.command}
        </code>
        <CopyButton text={x.command} ariaLabel={x.copyLabel} className={m.copy} />
      </div>
      <RouteLink route={x.link.route} className={`${s.link} ${m.installLink}`}>
        {x.link.label}
        {NBSP}
        <span aria-hidden="true">→</span>
      </RouteLink>
    </div>
  );
}

/** The four ways in, one ruled row of equal columns: each a title, a line, its status pill and its link. */
function Ways() {
  return (
    <div className={m.ways}>
      <h3 className={m.waysTitle}>{INTEGRATE.waysTitle}</h3>
      <p className={m.waysSub}>
        <KeepRich text={INTEGRATE.sub} />
      </p>
      <ul className={m.wayList} {...LIST}>
        {INTEGRATE.cards.map((c) => (
          <li key={c.title} className={m.way}>
            <h4 className={m.wayTitle}>{c.title}</h4>
            <p className={m.wayBody}>
              <KeepRich text={c.body} />
            </p>
            <div className={m.wayStatus}>
              <StatusPill row={c.status} />
            </div>
            {"route" in c.link ? (
              // The console's link is left out while its page is planned, not shown as plain text.
              <RouteLink
                route={c.link.route}
                whenPlanned="hide"
                className={`${s.link} ${m.wayLink}`}
              >
                {c.link.label}
                {NBSP}
                <span aria-hidden="true">→</span>
              </RouteLink>
            ) : (
              <Away className={`${s.link} ${m.wayLink}`} href={c.link.href} label={c.link.label} />
            )}
          </li>
        ))}
      </ul>
      <Install />
    </div>
  );
}

/**
 * The use cases, for the jobs an agent does under a mandate: the three uses first, each with its record, then the
 * console's one screenshot (ConsoleShots.tsx), then the four ways in and the install line. The SDK code, the addresses
 * and the outcome statuses are in the docs.
 */
export function Integrate() {
  return (
    <LandingSection
      id="integrate"
      head={{ eyebrow: INTEGRATE.eyebrow, title: INTEGRATE.title, lede: INTEGRATE.lede }}
    >
      <ul className={m.uses} id={USES_ID} {...LIST}>
        {INTEGRATE.who.map((w) => (
          <UseCard key={w.title} use={w} />
        ))}
      </ul>
      <ConsoleShot />
      <Ways />
    </LandingSection>
  );
}
