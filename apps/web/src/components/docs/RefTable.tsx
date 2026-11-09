import { Rich } from "@/components/site/Rich";
import { ScrollRegion } from "@/components/site/ScrollRegion";
import { refTable } from "@/lib/docs/ref";
import type { RefTable as RefTableData } from "@/lib/docs/ref/types";
import d from "./docs.module.css";

/** A reference table as the page shows it. Each row with an id is a deep-link target. */
export function RefTableView({ table }: { table: RefTableData }) {
  return (
    <ScrollRegion label={table.label} className={d.tableWrap}>
      <table>
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c.key} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, at) => (
            <tr key={row.id ?? at} id={row.id}>
              {table.columns.map((c) => (
                <td key={c.key}>
                  <Rich text={row.cells[c.key] ?? ""} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

/** `<RefTable id="vault-methods" />`: the table of that id from lib/docs/ref. */
export function RefTable({ id }: { id: string }) {
  return <RefTableView table={refTable(id)} />;
}
