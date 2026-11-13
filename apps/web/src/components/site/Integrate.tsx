import { RouteLink } from "@/components/RouteLink";
import { ExternalLink } from "@/components/ui";
import { INTEGRATE, SDK_SNIPPET } from "@/lib/site/facts";
import { Rich } from "./Rich";
import { ScrollRegion } from "./ScrollRegion";
import { StatusPill } from "./StatusPill";
import s from "./site.module.css";

export function Integrate() {
  return (
    <section className={s.section} id="integrate">
      <div className={s.wrap}>
        <p className={s.eyebrow}>{INTEGRATE.eyebrow}</p>
        <div className={s.sectionHead}>
          <h2 className={s.h2}>{INTEGRATE.title}</h2>
          <p>
            <Rich text={INTEGRATE.sub} />
          </p>
        </div>
        <div className={s.ways}>
          {INTEGRATE.cards.map((c) => {
            return (
              <div key={c.title} className={s.way}>
                <h3>
                  {c.title} <StatusPill row={c.status} />
                </h3>
                <p>
                  <Rich text={c.body} />
                </p>
                {"route" in c.link ? (
                  <RouteLink route={c.link.route} whenPlanned="hide" className={s.link}>
                    {c.link.label}
                  </RouteLink>
                ) : c.link.href.startsWith("#") ? (
                  <a className={s.link} href={c.link.href}>
                    {c.link.label}
                  </a>
                ) : (
                  <ExternalLink className={s.link} href={c.link.href}>
                    {c.link.label}
                  </ExternalLink>
                )}
              </div>
            );
          })}
        </div>
        <div className={s.codeBox}>
          <div className={s.codeHead}>
            <span>{INTEGRATE.fileName}</span>
            <span className={s.codeMeta}>
              {INTEGRATE.codeLabel}
              <StatusPill row={INTEGRATE.cards[0].status} />
            </span>
          </div>
          <ScrollRegion className={s.codeBody} label={INTEGRATE.fileName}>
            <pre>{SDK_SNIPPET}</pre>
          </ScrollRegion>
        </div>
        <p className={s.codeNote}>
          <Rich text={INTEGRATE.statusesLead} />{" "}
          {INTEGRATE.statuses.map((x, i) => (
            <span key={x}>
              {i === 0 ? "" : " · "}
              <code>{x}</code>
            </span>
          ))}
          .{" "}
          <RouteLink route={INTEGRATE.statusesLink.route} className={s.link}>
            {INTEGRATE.statusesLink.label}
          </RouteLink>
        </p>
        <p className={s.codeNote}>
          <Rich text={INTEGRATE.addresses} />
        </p>
        <ul className={s.devLinks} aria-label={INTEGRATE.devLinksLabel}>
          {INTEGRATE.devLinks.map((l) => (
            <li key={l.label}>
              {"route" in l ? (
                <RouteLink route={l.route} className={s.link}>
                  {l.label}
                </RouteLink>
              ) : (
                <ExternalLink className={s.link} href={l.href}>
                  {l.label}
                </ExternalLink>
              )}
            </li>
          ))}
        </ul>
        <div className={s.who}>
          {INTEGRATE.who.map((w) => {
            return (
              <div key={w.title}>
                <b>{w.title}</b>
                <span className={s.whoBody}>
                  <Rich text={w.body} />
                </span>
                <p className={s.whoControl}>
                  <strong>{w.control}</strong> <span aria-hidden="true">→</span>
                  <span className="sr-only">:</span> <Rich text={w.outcome} />
                </p>
                <p className={s.whoProof}>
                  <StatusPill row={w.status} inline={false} />
                  <ExternalLink className={s.link} href={w.evidence.url}>
                    {w.evidence.label}
                  </ExternalLink>
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
