import type { ReactNode } from "react";
import { Container } from "@/components/site/Container";

/** A vault's own proof page keeps its narrower width. /proof alone uses the site's full wrap. */
export default function VaultProofLayout({ children }: { children: ReactNode }) {
  return <Container>{children}</Container>;
}
