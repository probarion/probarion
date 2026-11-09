import type { MDXComponents } from "mdx/types";
import { DOCS_COMPONENTS } from "@/components/docs/mdx";

/** Required by @next/mdx: the components every docs page renders with. */
export function useMDXComponents(): MDXComponents {
  return DOCS_COMPONENTS;
}
