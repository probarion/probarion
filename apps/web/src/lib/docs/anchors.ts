import { VAULT_ERROR_CODES } from "@probarion/core";
import type { Root } from "mdast";
import { errorAnchor, HTTP_ERRORS, httpAnchor, SDK_ERRORS } from "./errors";
import { attrOf, jsxNodes } from "./mdast";
import { docsStatusRows } from "./status";
import { checkAnchor, selectChecks } from "./verifier";

/**
 * The anchors generated components put on a page, so links to #NoMandate or #check-a can be
 * checked. `file` names the page in the error when a prop is not a plain string.
 */
export function generatedAnchors(tree: Root, file = "<page>"): string[] {
  const out: string[] = [];
  for (const node of jsxNodes(tree)) {
    switch (node.name) {
      case "ErrorCatalog": {
        const kind = attrOf(node, "kind", file);
        if (kind === "vault") out.push(...VAULT_ERROR_CODES.map(errorAnchor));
        if (kind === "sdk") out.push(...SDK_ERRORS.map((e) => errorAnchor(e.name)));
        if (kind === "http") out.push(...HTTP_ERRORS.map((e) => httpAnchor(e.status, e.code)));
        break;
      }
      case "VerifierChecks":
        out.push(...selectChecks(attrOf(node, "only", file)).map(checkAnchor));
        break;
      case "StatusTable":
        out.push(...docsStatusRows().map((r) => r.id));
        break;
      case "HubSearch":
        out.push("popular");
        break;
      default:
        break;
    }
  }
  return out;
}
