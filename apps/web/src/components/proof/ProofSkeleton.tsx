"use client";

import { useParams } from "next/navigation";
import { SkeletonBar, SkeletonBody, SkeletonCard } from "@/components/pending/Skeleton";
import { segmentText } from "@/components/pending/segment";
import { Container } from "@/components/site/Container";

/**
 * What /proof and a vault's proof page show while the checks run (app/proof/loading.tsx). /proof mostly sends the
 * visitor on to the demo vault's page, so the shell is that page's frame and head (ProofView's Header): a Proof
 * eyebrow, then the vault's name from the address in the page's h1, or a bar where there is none yet. The line
 * under it and the result and checks cards are skeleton, after the 200 ms gate. The boundary sits above
 * /proof/[vault]'s layout, so the frame (Container) is drawn here.
 */
export function ProofSkeleton() {
  const vault = segmentText(useParams<{ vault?: string }>().vault);
  return (
    <Container>
      <div aria-busy="true" className="mx-auto min-h-[70vh] max-w-3xl">
        <header className="mb-6">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-gold-ink">
            Proof
          </p>
          {vault === null ? (
            <SkeletonBody>
              <SkeletonBar className="h-8 w-72 max-w-full sm:h-9" />
            </SkeletonBody>
          ) : (
            <h1 className="font-mono text-2xl tracking-tight text-ink break-all sm:text-3xl">
              {vault}
            </h1>
          )}
          <SkeletonBody>
            <SkeletonBar className="mt-2 h-[21px] w-80 max-w-full" />
          </SkeletonBody>
        </header>
        <SkeletonBody>
          <SkeletonCard bars={2} minH="min-h-[208px]" />
          <SkeletonCard minH="min-h-[200px]" />
        </SkeletonBody>
        <p className="sr-only">Loading the proof from NEAR…</p>
      </div>
    </Container>
  );
}
