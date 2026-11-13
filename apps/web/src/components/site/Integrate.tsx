import { createElement, type ReactNode } from "react";
import { RouteLink } from "@/components/RouteLink";
import { INTEGRATE, SDK_SNIPPET } from "@/lib/site/facts";
import { KeepRich, LIST, PartHead } from "./bits";
import m from "./integrate.module.css";
import { Away, StatusPill } from "./parts";
import p from "./parts.module.css";
import { ScrollRegion } from "./ScrollRegion";
import { LandingSection } from "./SectionHead";
import s from "./site.module.css";

/** The uses' part: the hero's pointer to the mainnet payouts lands on its heading. */
export const USES_ID = "integrate-uses";

/** The snippet as written, each comment in a span of its own so that it reads quieter than the code beside it. */
function Snippet({ code }: { code: string }) {
  const parts: ReactNode[] = [];
  for (const [i, line] of code.split("\n").entries()) {
    if (i > 0) parts.push("\n");
    const cut = line.indexOf(" // ");
    if (cut < 0) parts.push(line);
    else
      parts.push(
        line.slice(0, cut + 1),
        createElement("span", { className: m.comment }, line.slice(cut + 1)),
      );
  }
  return createElement("pre", null, ...parts);
}

type Link = { route: string; label: string } | { href: string; label: string; after?: string };

/** A link of the section: a page of this site in this tab, anything else in a new one, with its arrow. */
function Go({ link, className = s.link }: { link: Link; className?: string }) {
  if ("route" in link) {
    return (
      <RouteLink route={link.route} className={className}>
        {link.label}
      </RouteLink>
    );
  }
  return <Away className={className} href={link.href} label={link.label} after={link.after} />;
}

/** Part 1: the four ways in, as equal cards whose title, text, status and link line up across a row. */
function Ways() {
  return (
    <div className={m.part}>
      <PartHead title={INTEGRATE.parts.ways} />
      <ul className={m.ways} {...LIST}>
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
              </RouteLink>
            ) : (
              <Go link={c.link} className={`${s.link} ${m.wayLink}`} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Beside the code: the accounts to point an agent at, each on its own network's explorer. */
function Addresses() {
  const a = INTEGRATE.addresses;
  return (
    <div>
      <h4 className={p.label}>{a.title}</h4>
      <div className={m.addr}>
        {a.networks.map((n) => (
          <div key={n.name}>
            <p className={`${p.label} ${m.net}`}>{n.name}</p>
            <dl className={m.addrList}>
              {n.rows.map((r) => (
                <div key={r.term}>
                  <dt>{r.term}</dt>
                  {"none" in r ? (
                    <dd className={m.none}>{r.none}</dd>
                  ) : (
                    <dd>
                      <Away href={r.account.url} code={r.account.id} after={n.explorer} />
                      {"after" in r ? r.after : null}
                    </dd>
                  )}
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      <p className={m.more}>
        <Go link={a.link} />
      </p>
    </div>
  );
}

/** Beside the code: what `outcome.status` can be, and the page that says what each one means. */
function Statuses() {
  return (
    <div>
      <h4 className={p.label}>{INTEGRATE.statusesTitle}</h4>
      <p className={m.lead}>
        <KeepRich text={INTEGRATE.statusesLead} />
      </p>
      <ul className={m.chips} {...LIST}>
        {INTEGRATE.statuses.map((x) => (
          <li key={x}>
            <code>{x}</code>
          </li>
        ))}
      </ul>
      <p className={m.more}>
        <Go link={INTEGRATE.statusesLink} />
      </p>
    </div>
  );
}

/** Part 2: the SDK's one call with its reference beside it, then the docs and the source under both. */
function Code() {
  return (
    <div className={m.part}>
      <PartHead title={INTEGRATE.parts.code} note={INTEGRATE.parts.codeNote} />
      <div className={m.dev}>
        <div className={`${s.codeBox} ${m.code}`}>
          <div className={s.codeHead}>
            <span>{INTEGRATE.fileName}</span>
            <span>{INTEGRATE.codeLabel}</span>
          </div>
          <ScrollRegion className={s.codeBody} label={INTEGRATE.fileName}>
            <Snippet code={SDK_SNIPPET} />
          </ScrollRegion>
        </div>
        <div className={m.rail}>
          <Addresses />
          <Statuses />
        </div>
      </div>
      <div className={m.docsRow}>
        <h4 className={p.label}>{INTEGRATE.docs.title}</h4>
        <dl className={m.docs}>
          {INTEGRATE.docs.groups.map((g) => (
            <div key={g.name}>
              <dt>{g.name}</dt>
              <dd>
                {g.links.map((l) => (
                  <Go key={l.label} link={l} />
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** Part 3: the uses, one ruled row each; each network a use ran on is a run with what happened, its status and evidence. */
function Uses() {
  const [, controls] = INTEGRATE.usesHead;
  return (
    <div className={m.part}>
      <PartHead title={INTEGRATE.parts.uses} id={USES_ID} />
      {/* The heads are for the eye; the cell that needs its head carries it for a screen reader. */}
      <div className={`${m.useHead} ${p.label}`} aria-hidden="true">
        {INTEGRATE.usesHead.map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
      <ul className={m.uses} {...LIST}>
        {INTEGRATE.who.map((w) => (
          <li key={w.title} className={m.use}>
            <div className={m.name}>
              <h4 className={m.useTitle}>{w.title}</h4>
              <p className={m.useBody}>
                <KeepRich text={w.body} />
              </p>
            </div>
            <p className={m.ctl}>
              <span className={`${p.label} ${m.cellLab}`}>
                {controls}
                <span className="sr-only">: </span>
              </span>
              {w.control}
            </p>
            <div className={m.runs}>
              {w.runs.map((r) => (
                <div key={r.network} className={m.run}>
                  <p className={m.what}>
                    <span className={`${p.label} ${m.net}`}>
                      {r.network}
                      <span className="sr-only">: </span>
                    </span>
                    <KeepRich text={r.outcome} />
                  </p>
                  <div className={m.ev}>
                    <StatusPill row={r.status} />
                    {r.evidence.map((e) =>
                      e.label.includes(", tx ") ? (
                        <Away key={e.url} href={e.url} tx={e.label} />
                      ) : (
                        <Away key={e.url} href={e.url} label={e.label} />
                      ),
                    )}
                  </div>
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Integrate() {
  return (
    <LandingSection
      id="integrate"
      head={{ eyebrow: INTEGRATE.eyebrow, title: INTEGRATE.title, lede: INTEGRATE.sub }}
    >
      <Ways />
      <Code />
      <Uses />
    </LandingSection>
  );
}
