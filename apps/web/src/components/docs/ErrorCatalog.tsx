import { VAULT_ERROR_CODES } from "@probarion/core";
import { Rich } from "@/components/site/Rich";
import { ScrollRegion } from "@/components/site/ScrollRegion";
import { errorAnchor, HTTP_ERRORS, httpAnchor, SDK_ERRORS, VAULT_ERRORS } from "@/lib/docs/errors";
import d from "./docs.module.css";

/**
 * The error tables of build/errors, rendered from lib/docs/errors.ts. Each row is a deep-link
 * target.
 */
export function ErrorCatalog({ kind }: { kind: "vault" | "sdk" | "http" }) {
  if (kind === "vault") {
    return (
      <ScrollRegion label="Vault error codes" className={d.tableWrap}>
        <table>
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Meaning</th>
              <th scope="col">Raised by</th>
              <th scope="col">Retry helps</th>
              <th scope="col">What to do</th>
            </tr>
          </thead>
          <tbody>
            {VAULT_ERROR_CODES.map((code) => {
              const e = VAULT_ERRORS[code];
              return (
                <tr key={code} id={errorAnchor(code)}>
                  <td>
                    <code>{code}</code>
                  </td>
                  <td>
                    <Rich text={e.meaning} />
                  </td>
                  <td>
                    <Rich text={e.raisedBy} />
                  </td>
                  <td>{e.retryable ? "Yes" : "No"}</td>
                  <td>
                    <Rich text={e.next} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollRegion>
    );
  }
  if (kind === "sdk") {
    return (
      <ScrollRegion label="SDK error classes" className={d.tableWrap}>
        <table>
          <thead>
            <tr>
              <th scope="col">Class</th>
              <th scope="col">
                <code>.code</code>
              </th>
              <th scope="col">When</th>
              <th scope="col">Extra fields</th>
            </tr>
          </thead>
          <tbody>
            {SDK_ERRORS.map((e) => (
              <tr key={e.name} id={errorAnchor(e.name)}>
                <td>
                  <code>{e.name}</code>
                  <br />
                  <small>extends {e.parent}</small>
                </td>
                <td>
                  <code>{e.code}</code>
                </td>
                <td>
                  <Rich text={e.when} />
                </td>
                <td>{e.fields === "" ? "None" : <Rich text={e.fields} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    );
  }
  if (kind === "http") {
    return (
      <ScrollRegion label="HTTP error codes" className={d.tableWrap}>
        <table>
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Code</th>
              <th scope="col">Returned by</th>
              <th scope="col">Meaning</th>
              <th scope="col">What to do</th>
            </tr>
          </thead>
          <tbody>
            {HTTP_ERRORS.map((e) => (
              <tr key={`${e.status} ${e.code}`} id={httpAnchor(e.status, e.code)}>
                <td>{e.status}</td>
                <td>
                  <code>{e.code}</code>
                </td>
                <td>{e.where}</td>
                <td>
                  <Rich text={e.meaning} />
                </td>
                <td>
                  <Rich text={e.next} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    );
  }
  throw new Error(`ErrorCatalog: unknown kind "${String(kind)}"`);
}
