import { BAND, SPEND_REQUEST_FIELDS } from "@/lib/site/facts";
import { Rich } from "./Rich";
import { ScrollRegion } from "./ScrollRegion";
import s from "./site.module.css";

export function InkBand() {
  return (
    <section className={s.band} id="payee">
      <div className={`${s.wrap} ${s.bandGrid}`}>
        <div>
          <h2 className={s.h2}>{BAND.title}</h2>
          <p className={s.bandSub}>
            <Rich text={BAND.body} />
          </p>
        </div>
        <ScrollRegion className={s.struct} label={`The ${BAND.structName} fields`}>
          <span className={s.structMuted}>{`${BAND.structName} {`}</span>
          {SPEND_REQUEST_FIELDS.map((field) => (
            <span key={field} className={s.structField}>
              {field}
            </span>
          ))}
          <span className={`${s.structField} ${s.structGone}`}>
            {BAND.gone}
            <span className={s.structNote}>{BAND.goneNote}</span>
          </span>
          <span className={s.structMuted}>{"}"}</span>
        </ScrollRegion>
      </div>
    </section>
  );
}
