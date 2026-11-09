import { Rich } from "@/components/site/Rich";
import { ScrollRegion } from "@/components/site/ScrollRegion";
import { errorAnchor } from "@/lib/docs/errors";
import { docsHref, findPage } from "@/lib/docs/registry";
import { SPEND_CHECKS } from "@/lib/docs/spend-checks";
import d from "./docs.module.css";

/** The 14 checks in order. A code links to its entry on build/errors once that page exists. */
export function SpendChecks() {
  const errors = findPage("build/errors");
  return (
    <ScrollRegion label="The 14 spend checks" className={d.tableWrap}>
      <table>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">The vault asks</th>
            <th scope="col">Refused with</th>
          </tr>
        </thead>
        <tbody>
          {SPEND_CHECKS.map((c, at) => (
            <tr key={c.code}>
              <td>{at + 1}</td>
              <td>
                <Rich text={c.question} />
              </td>
              <td>
                {errors ? (
                  <a className={d.link} href={`${docsHref(errors.path)}#${errorAnchor(c.code)}`}>
                    <code>{c.code}</code>
                  </a>
                ) : (
                  <code>{c.code}</code>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
