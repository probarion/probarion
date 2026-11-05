import { isNearAccountId } from "@probarion/core";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, unstable_rethrow } from "next/navigation";
import { ProofLimited, ProofUnavailable, ProofView } from "@/components/proof/ProofView";
import { serviceDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { clientIp } from "@/lib/http";
import { log } from "@/lib/log";
import { proofDeps } from "@/lib/proof/deps";
import { loadProof, type ProofResult } from "@/lib/proof/service";
import { LIMITS, takeToken } from "@/lib/ratelimit";
import { BUILD_NETWORK } from "@/lib/site/network";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Props = { params: Promise<{ vault: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { vault } = await params;
  return { title: isNearAccountId(vault) ? `Proof · ${vault}` : "Proof" };
}

/**
 * The rate limit and the load, or null when either fails, so that the page says the checks did not run rather than
 * answering 500. Next's own control flow passes through the catch.
 */
async function readProof(vault: string, ip: string): Promise<ProofResult | "limited" | null> {
  try {
    const [max, windowSeconds] = LIMITS.proofPage;
    const { allowed } = await takeToken(serviceDb(), `proof:${ip}`, max, windowSeconds);
    if (!allowed) return "limited";
    return await loadProof(await proofDeps(), vault);
  } catch (error) {
    unstable_rethrow(error);
    log.warn("proof.unavailable", {
      vault,
      reason: "database",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * A vault's live checks a-i, for anyone when its owner made the page public, else for its members. The id is
 * checked against the NEAR AccountId grammar before any database or RPC call: anything else is a 404.
 */
export default async function ProofPage({ params }: Props) {
  const { vault } = await params;
  if (!isNearAccountId(vault)) notFound();
  const r = await readProof(vault, clientIp(await headers()));
  // The environment may be what failed, so this reads the network the build was made for.
  if (r === null)
    return <ProofUnavailable vault={vault} network={BUILD_NETWORK} reason="database" />;
  if (r === "limited") return <ProofLimited vault={vault} network={getEnv().NEAR_NETWORK} />;
  if (r.status === "not_found") notFound();
  if (r.status === "error") {
    return <ProofUnavailable vault={r.vault} network={r.network} reason={r.reason} />;
  }
  return <ProofView result={r} />;
}
