import type { Metadata } from "next";
import Link from "next/link";
import c from "@/components/site/canary.module.css";
import { Rich } from "@/components/site/Rich";
import s from "@/components/site/site.module.css";
import { brandCardClass, ExternalLink } from "@/components/ui";
import { LINKS } from "@/lib/site/facts";
import { BLAST_RADIUS, SECURITY_PAGE as P } from "@/lib/site/ops-copy";

export const metadata: Metadata = { title: P.meta.title, description: P.meta.description };

const H2 = "mb-3 text-xl font-semibold";

/** The security summary. SECURITY.md is the policy; this page says the same in short and links it. Static. */
export default function SecurityPage() {
  return (
    <div className={`${s.site} ${s.wrap} ${c.page}`}>
      <p className={s.eyebrow}>{P.eyebrow}</p>
      <h1 className={c.title}>{P.title}</h1>
      <p className={c.lede}>{P.lede}</p>

      <section className={brandCardClass}>
        <h2 className={H2}>{P.report.title}</h2>
        {P.report.paragraphs.map((t) => (
          <p key={t} className="mb-2">
            {t}
          </p>
        ))}
        <p>
          <ExternalLink className={s.link} href={LINKS.x}>
            {P.report.x}
          </ExternalLink>
        </p>
      </section>

      <section className={brandCardClass}>
        <h2 className={H2}>{P.enforces.title}</h2>
        <ul className="list-disc pl-5">
          {P.enforces.items.map((t) => (
            <li key={t} className="mb-1">
              <Rich text={t} />
            </li>
          ))}
        </ul>
      </section>

      <section className={brandCardClass}>
        <h2 className={H2}>{P.breach.title}</h2>
        <p className="mb-3">{P.breach.lede}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th scope="col" className="py-2 pr-4">
                  {P.breach.can}
                </th>
                <th scope="col" className="py-2">
                  {P.breach.cannot}
                </th>
              </tr>
            </thead>
            <tbody>
              {BLAST_RADIUS.map((row) => (
                <tr key={row.can} className="border-t border-ink/10">
                  <td className="py-2 pr-4 align-top">
                    <Rich text={row.can} />
                  </td>
                  <td className="py-2 align-top">
                    <Rich text={row.cannot} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={brandCardClass}>
        <h2 className={H2}>{P.limits.title}</h2>
        <ul className="mb-2 list-disc pl-5">
          {P.limits.items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <p>
          <ExternalLink className={s.link} href={`${LINKS.security}#what-is-not-proven-yet`}>
            {P.limits.more}
          </ExternalLink>
        </p>
      </section>

      <section className={brandCardClass}>
        <h2 className={H2}>{P.relies.title}</h2>
        <ul className="list-disc pl-5">
          {P.relies.items.map((t) => (
            <li key={t} className="mb-1">
              {t}
            </li>
          ))}
        </ul>
      </section>

      <section className={brandCardClass}>
        <h2 className={H2}>{P.verify.title}</h2>
        <p className="break-words">
          <Rich text={P.verify.text} />
        </p>
      </section>

      <section className={brandCardClass}>
        <h2 className={H2}>{P.links.title}</h2>
        <ul className="list-disc pl-5">
          <li>
            <ExternalLink className={s.link} href={LINKS.security}>
              {P.links.policy}
            </ExternalLink>
          </li>
          <li>
            <ExternalLink className={s.link} href={LINKS.threatModel}>
              {P.links.threatModel}
            </ExternalLink>
          </li>
          <li>
            <ExternalLink className={s.link} href={LINKS.runbook}>
              {P.links.runbook}
            </ExternalLink>
          </li>
          <li>
            <a className={s.link} href="/.well-known/security.txt">
              {P.links.securityTxt}
            </a>
          </li>
          <li>
            <Link className={s.link} href="/canary/rules">
              {P.links.canaryRules}
            </Link>
          </li>
        </ul>
      </section>
    </div>
  );
}
