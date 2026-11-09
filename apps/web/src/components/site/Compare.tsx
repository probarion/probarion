import { COMPARE, type StatusTone, statusOf } from "@/lib/site/facts";
import { Rich } from "./Rich";
import s from "./site.module.css";

const TONE: Readonly<Record<StatusTone, string | undefined>> = {
  live: s.live,
  work: s.work,
  plan: s.plan,
};

export function Compare() {
  return (
    <section className={`${s.section} ${s.flush}`} id="compare">
      <div className={s.wrap}>
        <p className={s.eyebrow}>{COMPARE.eyebrow}</p>
        <div className={s.sectionHead}>
          <h2 className={s.h2}>{COMPARE.title}</h2>
          <p>{COMPARE.sub}</p>
        </div>
        <table className={s.compare}>
          <thead className={s.compareHead}>
            <tr>
              {COMPARE.head.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARE.rows.map((r) => {
              const st = statusOf(r.status);
              return (
                <tr key={r.question}>
                  <th scope="row" className={s.compareRow}>
                    {r.question}
                  </th>
                  <td className={s.compareDiy} data-label={COMPARE.head[1]}>
                    {r.diy}
                  </td>
                  <td data-label={COMPARE.head[2]}>
                    <Rich text={r.probarion} />{" "}
                    <span className={`${s.pill} ${TONE[st.tone]}`}>{st.pill}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
