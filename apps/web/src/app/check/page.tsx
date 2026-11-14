import type { Metadata } from "next";
import c from "@/components/site/canary.module.css";
import s from "@/components/site/site.module.css";
import { brandCardClass, ExternalLink } from "@/components/ui";
import { CHECK_PAGE as P } from "./copy";
import { PayeeCheck } from "./PayeeCheck";

export const metadata: Metadata = { title: P.meta.title, description: P.meta.description };

const H2 = "mb-3 text-xl font-semibold";

/**
 * /check: a payee's verdict (allow, warn or block) with its reasons, before an owner writes the payee into a mandate.
 * Static: the check itself runs in the visitor's browser (PayeeCheck), against public nodes, so no server route takes
 * a payee and nothing is stored. The console's mandate form is unchanged.
 */
export default function CheckPage() {
  return (
    <div className={`${s.site} ${s.wrap} ${c.page} ${c.reading}`}>
      <p className={s.eyebrow}>{P.eyebrow}</p>
      <h1 className={c.title}>{P.title}</h1>
      <p className={c.lede}>{P.lede}</p>
      <p className="mt-4">{P.why}</p>
      <p>{P.how}</p>

      <section className={`${brandCardClass} mt-8`} aria-labelledby="check-form-title">
        <h2 id="check-form-title" className={H2}>
          {P.form.title}
        </h2>
        <PayeeCheck />
      </section>

      <section className={brandCardClass} aria-labelledby="check-about-title">
        <h2 id="check-about-title" className={H2}>
          {P.about.title}
        </h2>
        <ul className="list-disc pl-5">
          {P.about.items.map((t) => (
            <li key={t} className="mb-2">
              {t}
            </li>
          ))}
        </ul>
        <p className="mt-3">
          {P.about.sources}{" "}
          {P.about.links.map((l, i) => (
            <span key={l.href}>
              {i === 0 ? "" : ", "}
              <ExternalLink className={s.link} href={l.href}>
                {l.label}
              </ExternalLink>
            </span>
          ))}
          .
        </p>
      </section>
    </div>
  );
}
