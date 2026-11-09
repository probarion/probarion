import { ScrollRegion } from "@/components/site/ScrollRegion";
import { docsStatusRows } from "@/lib/docs/status";
import { StatusChip } from "./chips";
import d from "./docs.module.css";

/** The landing page's status rows, the same source (lib/site/facts.ts STATUS). */
export function StatusTable() {
  return (
    <ScrollRegion label="What works today" className={d.tableWrap}>
      <table>
        <thead>
          <tr>
            <th scope="col">Feature</th>
            <th scope="col">Status</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {docsStatusRows().map((r) => (
            <tr key={r.id} id={r.id}>
              <td>{r.feature}</td>
              <td>
                <StatusChip status={r.status} />
              </td>
              <td>{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
