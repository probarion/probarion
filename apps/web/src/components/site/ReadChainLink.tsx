"use client";

import type { ReactNode } from "react";
import { requestMainnetRead } from "@/lib/site/mainnet-read";

/**
 * A link to the mainnet payouts that also reads one of them. With no JavaScript it only scrolls to `href`; with it, the
 * click also asks the stone of `payoutId` to read the chain, as its own button does, while the page scrolls there.
 */
export function ReadChainLink({
  payoutId,
  href,
  className,
  children,
}: {
  payoutId: string;
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a href={href} className={className} onClick={() => requestMainnetRead(payoutId)}>
      {children}
    </a>
  );
}
