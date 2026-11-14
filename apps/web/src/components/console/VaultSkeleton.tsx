"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { LinkPending } from "@/components/pending/LinkPending";
import { SkeletonBar, SkeletonBody, SkeletonCard } from "@/components/pending/Skeleton";
import { segmentText } from "@/components/pending/segment";
import { VaultNav } from "./VaultNav";

/**
 * What a vault page shows while its server reads run (app/console/[vault]/loading.tsx). The head is the pages' own:
 * the vault's name from the address, in the h1 every vault page uses, and the real tab bar, which already marks the
 * tab that was clicked (usePathname is the new address while this shows). The role line and the cards are skeleton,
 * after the 200 ms gate. The shell holds 70% of the screen, so the footer does not jump up and back down.
 *
 * A spend's approval page (approve/[spend]), the one an alert opens on a phone, has no tab bar: its shell is that
 * page's narrow column, with the link back to the vault and the spend's number as its h1.
 */
export function VaultSkeleton() {
  const params = useParams<{ vault?: string; spend?: string }>();
  const vault = segmentText(params.vault) ?? "";
  const spend = segmentText(params.spend);
  if (spend !== null) {
    return (
      <div aria-busy="true" className="mx-auto min-h-[70vh] max-w-xl">
        <p className="text-sm leading-6">
          <Link
            className="inline-flex min-h-11 items-center text-sm text-ink underline decoration-ink/60 underline-offset-2 hover:decoration-ink"
            href={`/console/${encodeURIComponent(vault)}`}
          >
            <span aria-hidden="true">←&nbsp;</span>
            <span className="mono wrap-anywhere">{vault}</span>
            <LinkPending />
          </Link>
        </p>
        <h1 className="mt-1 text-2xl font-semibold">Spend #{spend}</h1>
        <SkeletonBody>
          <SkeletonBar className="mb-4 h-6 w-40 max-w-full" />
          <SkeletonCard minH="min-h-[200px]" />
          <SkeletonCard bars={2} minH="min-h-[140px]" />
        </SkeletonBody>
        <p className="sr-only">Loading the spend from NEAR…</p>
      </div>
    );
  }
  return (
    <div aria-busy="true" className="min-h-[70vh]">
      <h1 className="mono mb-1 text-2xl font-semibold break-all">{vault}</h1>
      <SkeletonBody>
        <SkeletonBar className="mb-4 h-[21px] w-48 max-w-full" />
      </SkeletonBody>
      <VaultNav vault={vault} />
      <SkeletonBody>
        <SkeletonCard minH="min-h-[168px]" />
        <SkeletonCard minH="min-h-[168px]" />
        <SkeletonCard bars={2} minH="min-h-[130px]" />
      </SkeletonBody>
      <p className="sr-only">Loading the vault from NEAR…</p>
    </div>
  );
}
