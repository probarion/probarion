import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Notice } from "@/components/ui";
import { publicDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { publicDemoTarget } from "@/lib/proof/service";

export const metadata: Metadata = { title: "Proof" };
export const dynamic = "force-dynamic";

/**
 * `/proof` with no vault: the demo vault (PROBARION_VAULT_ID), when its proof page is public on this network.
 * Otherwise, and when the database cannot say (`publicDemoTarget` catches the error), rather than a redirect to a 404
 * or an error page, it says how to open a vault's page.
 */
export default async function ProofIndex() {
  const env = getEnv();
  const target = await publicDemoTarget(
    { publicDb: publicDb(), network: env.NEAR_NETWORK },
    env.PROBARION_VAULT_ID,
  );
  if (target) redirect(target);
  return (
    <div className="mx-auto max-w-3xl">
      <Notice>Open /proof/&lt;vault account&gt; to see a vault&apos;s checks.</Notice>
    </div>
  );
}
