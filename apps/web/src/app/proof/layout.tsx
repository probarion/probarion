import type { ReactNode } from "react";
import { Container } from "@/components/site/Container";

export default function ProofLayout({ children }: { children: ReactNode }) {
  return <Container>{children}</Container>;
}
