import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Notice } from "@/components/ui";
import { getEnv } from "@/lib/env";
import { proofIndexTarget } from "@/lib/proof/view";

export const metadata: Metadata = { title: "Proof" };
export const dynamic = "force-dynamic";

/** `/proof` with no vault: the demo vault (PROBARION_VAULT_ID), when one is set. */
export default function ProofIndex() {
  const target = proofIndexTarget(getEnv().PROBARION_VAULT_ID);
  if (target) redirect(target);
  return (
    <div className="mx-auto max-w-3xl">
      <Notice>Open /proof/&lt;vault account&gt; to see a vault&apos;s checks.</Notice>
    </div>
  );
}
