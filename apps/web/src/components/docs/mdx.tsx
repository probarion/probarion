import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";

export const DOCS_COMPONENTS: MDXComponents = {
  h2: (props: ComponentProps<"h2">) => <h2 {...props} data-docs="h2" />,
};
