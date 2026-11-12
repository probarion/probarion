import type { Metadata } from "next";
import Link from "next/link";
import c from "@/components/site/canary.module.css";
import { Rich } from "@/components/site/Rich";
import s from "@/components/site/site.module.css";
import { ExternalLink } from "@/components/ui";
import { LINKS } from "@/lib/site/facts";
import { LEGAL_STATUS, TERMS_PAGE as T, type TermsRule } from "@/lib/site/ops-copy";

export const metadata: Metadata = { title: T.meta.title, description: T.meta.description };

/** The terms, as numbered plain-language rules (the pattern of /canary/rules). Static. */
export default function TermsPage() {
  const rules: readonly TermsRule[] = T.rules;
  return (
    <div className={`${s.site} ${s.wrap} ${c.page} ${c.reading}`}>
      <p className={s.eyebrow}>{T.eyebrow}</p>
      <h1 className={c.title}>{T.title}</h1>
      <p className={c.lede}>{T.updated}</p>
      <p className="mb-6">{LEGAL_STATUS}</p>
      <ol className={c.rules}>
        {rules.map((rule) => (
          <li key={rule.title}>
            <strong>{rule.title}</strong> <Rich text={rule.body} />
            {rule.link ? (
              <>
                {" "}
                <Link href={rule.link.href}>{rule.link.text}</Link>
              </>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="mt-6">
        {T.contact}{" "}
        <ExternalLink className={s.link} href={LINKS.x}>
          @probarionhq
        </ExternalLink>{" "}
        on X.
      </p>
    </div>
  );
}
