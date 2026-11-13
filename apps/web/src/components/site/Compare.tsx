import { COMPARE, statusOf } from "@/lib/site/facts";
import { KeepRich } from "./bits";
import c from "./compare.module.css";
import { Away, StatusPill } from "./parts";
import { LandingSection } from "./SectionHead";

/**
 * The table's roles, said out loud. They are redundant on paper, but the stylesheet turns the table into blocks below
 * 961 px, and some readers then drop its table semantics: an explicit role keeps them. They are spread from here
 * because Biome's noRedundantRoles reads the markup, not the stylesheet.
 */
const ROLE = {
  table: { role: "table" },
  rowgroup: { role: "rowgroup" },
  row: { role: "row" },
  columnheader: { role: "columnheader" },
  rowheader: { role: "rowheader" },
  cell: { role: "cell" },
} as const;

/** One class per column header, in COMPARE.head's order: on a wide screen they set the four column widths. */
const COLUMN = [c.colQuestion, c.colDiy, `${c.colOurs} ${c.headOurs}`, c.colStatus] as const;

/** The groups in their order, each with its rows in the rows' own order. */
const GROUPS = COMPARE.groups.map((g) => ({
  ...g,
  rows: COMPARE.rows.filter((r) => r.group === g.id),
}));

export function Compare() {
  return (
    <LandingSection
      id="compare"
      head={{ eyebrow: COMPARE.eyebrow, title: COMPARE.title, lede: COMPARE.sub }}
    >
      <table className={c.table} aria-labelledby="compare-title" {...ROLE.table}>
        <thead className={c.head} {...ROLE.rowgroup}>
          <tr {...ROLE.row}>
            {COMPARE.head.map((h, i) => (
              <th key={h} scope="col" className={COLUMN[i]} {...ROLE.columnheader}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        {GROUPS.map((g) => (
          <tbody key={g.id} {...ROLE.rowgroup}>
            <tr className={c.group} {...ROLE.row}>
              <th colSpan={COMPARE.head.length} scope="rowgroup" {...ROLE.rowheader}>
                {g.label}
              </th>
            </tr>
            {g.rows.map((r) => (
              <tr key={r.question} {...ROLE.row}>
                <th scope="row" className={c.question} {...ROLE.rowheader}>
                  {r.question}
                </th>
                <td className={c.diy} {...ROLE.cell}>
                  <span className={c.runIn} aria-hidden="true">
                    {COMPARE.short.diy}
                  </span>
                  {r.diy}
                </td>
                <td className={c.ours} {...ROLE.cell}>
                  <span className={c.runIn} aria-hidden="true">
                    {COMPARE.short.probarion}
                  </span>
                  <KeepRich text={r.probarion} />
                </td>
                <td className={c.status} {...ROLE.cell}>
                  {/* The column head names it, so the pill has no "Status: " of its own. */}
                  <StatusPill row={r.status} prefix={false} />
                  <span className="sr-only">{COMPARE.sourceJoin}</span>
                  <span className={c.source}>{statusOf(r.status).row}</span>
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      <div className={c.more}>
        <p className={c.moreLink}>
          <Away href={COMPARE.more.href} label={COMPARE.more.label} />
        </p>
        <p className={c.moreNote}>{COMPARE.more.note}</p>
      </div>
    </LandingSection>
  );
}
