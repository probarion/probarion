import { isNearAccountId } from "@probarion/core";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, unstable_rethrow } from "next/navigation";
import { ProofLimited, ProofUnavailable, ProofView } from "@/components/proof/ProofView";
import type { Network } from "@/lib/config";
import { serviceDb } from "@/lib/db/clients";
import { clientIp } from "@/lib/http";
import { log } from "@/lib/log";
import { canonicalUrl, softRequestNetwork } from "@/lib/network";
import { fullCardSeq } from "@/lib/proof/audit-link";
import { cachedDecisionRows } from "@/lib/proof/decision-cache";
import type { DecisionRow } from "@/lib/proof/decisions";
import { proofDeps } from "@/lib/proof/deps";
import { loadProof, type ProofOk, type ProofResult } from "@/lib/proof/service";
import { LIMITS, takeToken } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Props = {
  params: Promise<{ vault: string }>;
  /** `?seq=N` asks for the full card of an older decision, which the page otherwise shows as its summary line. */
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/** A vault's page names itself at this address's network (lib/network canonicalUrl), without `?seq=`. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { vault } = await params;
  if (!isNearAccountId(vault)) return { title: "Proof" };
  return {
    title: `Proof · ${vault}`,
    alternates: { canonical: await canonicalUrl(`/proof/${vault}`) },
  };
}

/**
 * The rate limit and the load, or null when either fails, so that the page says the checks did not run rather than
 * answering 500. Next's own control flow passes through the catch.
 */
async function readProof(
  network: Network,
  vault: string,
  ip: string,
): Promise<ProofResult | "limited" | null> {
  try {
    const [max, windowSeconds] = LIMITS.proofPage;
    const { allowed } = await takeToken(serviceDb(), `proof:${ip}`, max, windowSeconds);
    if (!allowed) return "limited";
    return await loadProof(await proofDeps(network), vault);
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
 * checked against the NEAR AccountId grammar before any database or RPC call: anything else is a 404. The network is
 * that of the address the page was opened at; a vault registered on the other one is not served here (a 404).
 */
export default async function ProofPage({ params, searchParams }: Props) {
  const { vault } = await params;
  if (!isNearAccountId(vault)) notFound();
  // The environment may be what failed, so the network falls back to the public map built into the page.
  const network = await softRequestNetwork();
  const r = await readProof(network, vault, clientIp(await headers()));
  if (r === null) return <ProofUnavailable vault={vault} network={network} reason="database" />;
  if (r === "limited") return <ProofLimited vault={vault} network={network} />;
  if (r.status === "not_found") notFound();
  if (r.status === "error") {
    return <ProofUnavailable vault={r.vault} network={r.network} reason={r.reason} />;
  }
  return (
    <ProofView
      result={r}
      decisions={await readDecisions(r)}
      fullSeq={fullCardSeq((await searchParams)?.seq)}
    />
  );
}

/**
 * Each decision of the snapshot the checks ran on, with A1 to A7 per entry, built once per cached snapshot (not per
 * view). `decisionRows` never throws on a crafted ledger; should it fail all the same, the page still shows the checks
 * and says the decisions could not be listed.
 */
async function readDecisions(r: ProofOk): Promise<DecisionRow[] | null> {
  try {
    return await cachedDecisionRows(r.snapshot, r.network);
  } catch (error) {
    log.warn("proof.decisions_unavailable", {
      vault: r.vault,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
