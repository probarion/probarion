import Link from "next/link";
import { KeepRich } from "@/components/site/bits";
import c from "@/components/site/canary.module.css";
import u from "@/components/site/usage.module.css";
import { brandCardClass, ExternalLink } from "@/components/ui";
import { TESTED, type TestedRow, type TestedSource } from "@/lib/site/tested";
import { repoFile } from "./evidence";

// The card of /usage that says how far Probarion is tested, from lib/site/tested.ts: the same dated rows as the
// README's "Tested, in numbers". It is built into the page and reads nothing at request time, so it shows the same
// whether or not the database can be read, and none of it is added into the counts below it.

/** A row's source: a page of this site in the same tab (named as from /usage), a file or a CI log in a new one. */
function SourceLink({ source }: { source: TestedSource }) {
  if (source.href.startsWith("/")) {
    return (
      <Link className={c.link} href={`${source.href}?via=usage`}>
        {source.label}
      </Link>
    );
  }
  const href = source.href.startsWith("https://") ? source.href : repoFile(source.href);
  return (
    <ExternalLink className={c.link} href={href}>
      {source.label}
    </ExternalLink>
  );
}

function Row({ row }: { row: TestedRow }) {
  return (
    <li>
      <p className={u.testedWhat}>
        <KeepRich text={row.what} />
      </p>
      <p>
        <KeepRich text={row.figure} />
      </p>
      <p className={u.testedAt}>
        <KeepRich text={`Read: ${row.at}.`} /> Source:{" "}
        {row.sources.map((source, i) => (
          <span key={source.href}>
            {i === 0 ? null : ", "}
            <SourceLink source={source} />
          </span>
        ))}
      </p>
    </li>
  );
}

/** How far it is tested: one item per row, so that a phone shows each figure whole, with where it was read. */
export function TestedCard({ tested = TESTED }: { tested?: typeof TESTED }) {
  return (
    <section id="tested" className={brandCardClass}>
      <h2 className={c.cardTitle}>{tested.cardTitle}</h2>
      <p className="max-w-measure">{tested.lede}</p>
      <ul className={u.tested}>
        {tested.rows.map((row) => (
          <Row key={row.what} row={row} />
        ))}
      </ul>
    </section>
  );
}
