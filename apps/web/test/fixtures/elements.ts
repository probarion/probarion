import { isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * The elements of `type` in a tree as a component returned it, without rendering the components in it: what a page
 * passes to a child, such as a prop, can be read here even when the child shows it only after a click.
 */
export function elementsOf(node: ReactNode, type: unknown): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap((n) => elementsOf(n, type));
  if (!isValidElement(node)) return [];
  const children = (node.props as { children?: ReactNode }).children;
  return [...(node.type === type ? [node] : []), ...elementsOf(children, type)];
}
