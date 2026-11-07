import Link from "next/link";
import { Rich } from "@/components/site/Rich";
import s from "@/components/site/site.module.css";
import { EXTENSION_PRIVACY as E } from "@/lib/site/ops-copy";

/**
 * The browser extension's part of /privacy (spec §8): the page's last section, which the Chrome Web Store listing
 * will link to. Its words are EXTENSION_PRIVACY in lib/site/ops-copy.ts, under that file's banned-word test.
 */
export function ExtensionPrivacy() {
  return (
    <section id={E.id} className="mb-8">
      <h2 className="mb-2 text-lg font-semibold">{E.title}</h2>
      {E.paragraphs.map((t) => (
        <p key={t} className="mb-2">
          <Rich text={t} />
        </p>
      ))}
      <p className="mb-2">
        {E.end.text}{" "}
        <Link className={s.link} href="/extension">
          {E.end.link}
        </Link>
        .
      </p>
    </section>
  );
}
