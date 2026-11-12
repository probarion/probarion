import { ExternalLink } from "@/components/ui";
import { COMPARE, type StatusTone, statusOf } from "@/lib/site/facts";
import { Rich } from "./Rich";
import s from "./site.module.css";

const TONE: Readonly<Record<StatusTone, string | undefined>> = {
  live: s.live,
  work: s.work,
  plan: s.plan,
};

/**
 * The table's roles, said out loud. They are redundant on paper, but the stylesheet turns the table into blocks below
 * 960 px, and some readers then drop its table semantics: an explicit role keeps them. They are spread from here
 * because Biome's noRedundantRoles reads the markup, not the stylesheet.
 */
const ROLE = {
  table: { role: "table" },
  row: { role: "row" },
  columnheader: { role: "columnheader" },
  rowheader: { role: "rowheader" },
  cell: { role: "cell" },
} as const;

export function Compare() {
  return (
    <section className={`${s.section} ${s.flush}`} id="compare">
      <div className={s.wrap}>
        <p className={s.eyebrow}>{COMPARE.eyebrow}</p>
        <div className={s.sectionHead}>
          <h2 className={s.h2} id="compare-title">
            {COMPARE.title}
          </h2>
          <p>{COMPARE.sub}</p>
        </div>
        <table className={s.compare} aria-labelledby="compare-title" {...ROLE.table}>
          <thead className={s.compareHead}>
            <tr {...ROLE.row}>
              {COMPARE.head.map((h) => (
                <th key={h} scope="col" {...ROLE.columnheader}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARE.rows.map((r) => {
              const st = statusOf(r.status);
              return (
                <tr key={r.question} {...ROLE.row}>
                  <th scope="row" {...ROLE.rowheader} className={s.compareRow}>
                    {r.question}
                  </th>
                  <td {...ROLE.cell} className={s.compareDiy} data-label={COMPARE.head[1]}>
                    {r.diy}
                  </td>
                  <td {...ROLE.cell} data-label={COMPARE.head[2]}>
                    <Rich text={r.probarion} />{" "}
                    <span className={`${s.pill} ${s.pillInline} ${TONE[st.tone]}`}>{st.pill}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className={s.compareMore}>
          <ExternalLink className={s.link} href={COMPARE.more.href}>
            {COMPARE.more.label} <span aria-hidden="true">→</span>
          </ExternalLink>
        </p>
      </div>
    </section>
  );
}
