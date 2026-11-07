import Link from "next/link";
import { DocsBar } from "@/components/docs/DocsBar";
import d from "@/components/docs/docs.module.css";
import { docsHref, findPage } from "@/lib/docs/registry";

/** The docs 404, inside the docs bar: search, the home and (once it exists) the Glossary. */
export default function DocsNotFound() {
  const glossary = findPage("resources/glossary");
  return (
    <>
      <DocsBar current={null} path={null} />
      <section className={d.missing}>
        <p className={d.eyebrow}>404</p>
        <h1 className={d.title}>This docs page does not exist</h1>
        <p className={d.lede}>
          The address may be mistyped, or the page may come in a later release.
        </p>
        <ul className={d.missingLinks}>
          <li>
            <a href="/docs#popular" data-docs-search="" className={d.link}>
              Search the docs
            </a>
          </li>
          <li>
            <Link href="/docs" className={d.link}>
              Docs home
            </Link>
          </li>
          {glossary && (
            <li>
              <Link href={docsHref(glossary.path)} className={d.link}>
                Glossary
              </Link>
            </li>
          )}
        </ul>
      </section>
    </>
  );
}
