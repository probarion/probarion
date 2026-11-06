import type { ReactNode } from "react";
import { Container } from "@/components/site/Container";

/**
 * The small card of a public page that does one thing (the pages an alert email links to), in the shape of the sign-in
 * page's: an eyebrow, a title, and whatever the page has to say or ask.
 */
export function PublicCard({
  eyebrow = "Alerts",
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <Container>
      <div className="mx-auto my-6 max-w-lg rounded-3xl border border-line bg-surface p-6 sm:my-10 sm:p-8">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-gold-small">{eyebrow}</p>
        <h1 className="mt-3 text-3xl font-light tracking-tight">{title}</h1>
        {children}
      </div>
    </Container>
  );
}
