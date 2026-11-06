import type { Metadata } from "next";
import c from "@/components/site/canary.module.css";
import s from "@/components/site/site.module.css";
import {
  Definitions,
  PilotsCard,
  Unavailable,
  UnitCostsCard,
  UsageHeader,
  UsageTable,
  UsageTiles,
} from "@/components/usage/UsageSections";
import type { Network } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { BUILD_NETWORK } from "@/lib/site/network";
import { USAGE_COPY } from "@/lib/usage/copy";
import { loadUsage } from "@/lib/usage/data";
import type { UsageMetrics } from "@/lib/usage/parse";
import { NEARAI_PRICE } from "@/lib/usage/pricing";

export const metadata: Metadata = {
  title: USAGE_COPY.meta.title,
  description: USAGE_COPY.meta.description,
};
// The numbers come from the database (behind their own cache, lib/usage/data.ts), so the page is not prerendered at build time.
export const dynamic = "force-dynamic";

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The network the app runs on and its numbers, or null for the numbers when anything fails. Settings that cannot be
 * read are the same "not available" as a database that cannot be: the network then comes from the build.
 */
async function load(): Promise<{ network: Network; usage: UsageMetrics | null }> {
  let network: Network = BUILD_NETWORK;
  try {
    network = getEnv().NEAR_NETWORK;
  } catch (error) {
    log.warn("usage.env_unreadable", { error: reason(error) });
    return { network, usage: null };
  }
  try {
    return { network, usage: await loadUsage(network) };
  } catch (error) {
    // loadUsage does not throw. If it ever does, it is still a page and not a 500.
    log.warn("usage.unavailable", { error: reason(error) });
    return { network, usage: null };
  }
}

/**
 * The public usage numbers: counts of vaults, payments, refusals and decisions, with the team, external owners and Canary
 * participants in separate columns, and what each number means. The numbers are for the network the app runs on. When
 * they cannot be read the page says so and keeps the header and the definitions: it does not fail for want of them.
 */
export default async function UsagePage() {
  const { network, usage } = await load();
  return (
    <div className={`${s.site} ${s.wrap} ${c.page}`}>
      <UsageHeader network={network} />
      {usage === null ? (
        <Unavailable />
      ) : (
        <>
          <UsageTiles usage={usage} />
          <UsageTable usage={usage} />
          <div className={c.pair}>
            <UnitCostsCard totals={usage.totals} price={NEARAI_PRICE} />
            <PilotsCard pilots={usage.pilots} names={usage.pilot_names} />
          </div>
        </>
      )}
      <Definitions network={network} />
    </div>
  );
}
