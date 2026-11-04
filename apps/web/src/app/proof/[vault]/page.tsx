import { isNearAccountId } from "@probarion/core";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ProofLimited, ProofUnavailable, ProofView } from "@/components/proof/ProofView";
import { serviceDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { clientIp } from "@/lib/http";
import { proofDeps } from "@/lib/proof/deps";
import { loadProof } from "@/lib/proof/service";
import { LIMITS, takeToken } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Props = { params: Promise<{ vault: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { vault } = await params;
  return { title: isNearAccountId(vault) ? `Proof · ${vault}` : "Proof" };
}

/**
 * A vault's live checks a-i, for anyone when its owner made the page public, else for its members. The id is
 * checked against the NEAR AccountId grammar before any database or RPC call: anything else is a 404.
 */
export default async function ProofPage({ params }: Props) {
  const { vault } = await params;
  if (!isNearAccountId(vault)) notFound();
  const [max, windowSeconds] = LIMITS.proofPage;
  const bucket = `proof:${clientIp(await headers())}`;
  if (!(await takeToken(serviceDb(), bucket, max, windowSeconds)).allowed) {
    return <ProofLimited vault={vault} network={getEnv().NEAR_NETWORK} />;
  }
  const r = await loadProof(await proofDeps(), vault);
  if (r.status === "not_found") notFound();
  if (r.status === "error") {
    return <ProofUnavailable vault={r.vault} network={r.network} reason={r.reason} />;
  }
  return <ProofView result={r} />;
}
