import { isValidElement, type ReactElement, type ReactNode } from "react";

/** The text a React node tree shows: the code a shiki block holds, or a heading's words. */
export function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

/** The outermost elements of one HTML type ("pre", "th") in a node tree, in document order. */
function elementsOf(node: ReactNode, type: string): ReactElement<{ children?: ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap((child) => elementsOf(child, type));
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return node.type === type ? [node] : elementsOf(node.props.children, type);
}

/**
 * The code a block holds, without its last newline. In a rendered code frame that is the text of
 * its `pre`, not the language label in the frame's head.
 */
export function codeText(node: ReactNode): string {
  return nodeText(elementsOf(node, "pre").at(0) ?? node).replace(/\n$/, "");
}

/** A table's name from its header row ("Table: #, Code"), so the tables on one page differ. */
export function tableLabel(table: ReactNode): string {
  const head = elementsOf(table, "thead").at(0);
  const words = elementsOf(head?.props.children, "th")
    .map((th) => nodeText(th).trim())
    .filter(Boolean);
  return words.length > 0 ? `Table: ${words.join(", ")}` : "Table";
}
