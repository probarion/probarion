import { RouteLink } from "@/components/RouteLink";
import { ExternalLink } from "@/components/ui";
import { INTEGRATE, SDK_SNIPPET, type StatusTone, statusOf } from "@/lib/site/facts";
import { Rich } from "./Rich";
import { ScrollRegion } from "./ScrollRegion";
import s from "./site.module.css";

const TONE: Readonly<Record<StatusTone, string | undefined>> = {
  live: s.live,
  work: s.work,
  plan: s.plan,
};

export function Integrate() {
  const sdk = statusOf(INTEGRATE.cards[0].status);
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
            const st = statusOf(c.status);
            return (
              <div key={c.title} className={s.way}>
                <h3>
                  {c.title}{" "}
                  <span className={`${s.pill} ${s.pillInline} ${TONE[st.tone]}`}>{st.pill}</span>
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
              <span className={`${s.pill} ${s.pillInline} ${TONE[sdk.tone]}`}>{sdk.pill}</span>
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
        </p>
        <div className={s.who}>
          {INTEGRATE.who.map((w) => (
            <div key={w.title}>
              <b>{w.title}</b>
              <span>{w.body}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
