import type { Metadata } from "next";
import c from "@/components/site/canary.module.css";
import { Rich } from "@/components/site/Rich";
import s from "@/components/site/site.module.css";
import { LEGAL_STATUS, PRIVACY_PAGE as P } from "@/lib/site/ops-copy";

export const metadata: Metadata = { title: P.meta.title, description: P.meta.description };

/**
 * The privacy notice. Static, the same on every address. Its sections are the container's last children, each
 * `<section id className="mb-8">` with an `h2.mb-2.text-lg.font-semibold`, so plan 06 Task 1 can add its section
 * after them with the same look. Nothing may follow the last section inside this container.
 */
export default function PrivacyPage() {
  return (
    <div className={`${s.site} ${s.wrap} ${c.page}`}>
      <p className={s.eyebrow}>{P.eyebrow}</p>
      <h1 className={c.title}>{P.title}</h1>
      <p className={c.lede}>{P.updated}</p>
      <p className="mb-8">{LEGAL_STATUS}</p>
      {P.sections.map((section) => (
        <section key={section.id} id={section.id} className="mb-8">
          <h2 className="mb-2 text-lg font-semibold">{section.title}</h2>
          {section.paragraphs.map((t) => (
            <p key={t} className="mb-2">
              <Rich text={t} />
            </p>
          ))}
        </section>
      ))}
      {/* Plan 06 Task 1 (E1a) renders <ExtensionPrivacy /> here: the last section, before this container closes. */}
    </div>
  );
}
