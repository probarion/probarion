import type { VaultConfig } from "@probarion/core";
import type { Metadata } from "next";
import { FundUsdcButton } from "@/components/console/FundUsdcButton";
import { TopUpPanel } from "@/components/console/TopUpPanel";
import { VaultNav } from "@/components/console/VaultNav";
import { VaultOnOtherNetwork } from "@/components/console/VaultOnOtherNetwork";
import { Card, Notice } from "@/components/ui";
import { requireMember } from "@/lib/auth/guard";
import type { Network } from "@/lib/config";
import { isVaultConfig } from "@/lib/console/vaults";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { chainErrorKind } from "@/lib/near/reader";
import { chainConsts, getReader } from "@/lib/near/server";
import { topupPlan } from "@/lib/topup/plan";

export const metadata: Metadata = { title: "Top-up" };
/** The wallet buttons here confirm their transaction on chain (FINAL), which can take a while. */
export const maxDuration = 60;

const muted = "text-[#0B0B0C]/60";

/** The vault's config, or null when it cannot be read (it is then said on the page, never guessed). */
async function readConfig(network: Network, vault: string): Promise<VaultConfig | null> {
  try {
    const config: unknown = await getReader(network).getConfig(vault);
    return isVaultConfig(config) ? config : null;
  } catch (e) {
    log.warn("console.read_failed", {
      what: "get_config",
      vault,
      kind: chainErrorKind(e) ?? "error",
    });
    return null;
  }
}

export default async function TopUpPage({ params }: { params: Promise<{ vault: string }> }) {
  const { vault: requested } = await params;
  // 404 for anyone who is not a member: a vault id is never confirmed to a stranger.
  const { session, member, elsewhere } = await requireMember(requested);
  if (elsewhere) return <VaultOnOtherNetwork {...elsewhere} />;
  const vault = member.vault_id;
  const network = member.network;
  if (member.role !== "owner") {
    // The tab is in every member's bar. Nothing here is offered to anyone else, and the routes and the action
    // answer only the owner too.
    return (
      <div>
        <h1 className="mono mb-1 text-2xl font-semibold break-all">{vault}</h1>
        <p className={`mb-4 text-sm ${muted}`}>Top-up · you are {member.role}</p>
        <VaultNav vault={vault} />
        <Notice>Only this vault&apos;s owner can top it up.</Notice>
      </div>
    );
  }
  const env = getEnv();
  const consts = chainConsts(network);
  const config = await readConfig(network, vault);
  const plan = topupPlan({
    network,
    config,
    account: session.accountId,
    consts,
    quotesConfigured: env.ONECLICK_JWT !== null,
  });

  return (
    <div>
      <h1 className="mono mb-1 text-2xl font-semibold break-all">{vault}</h1>
      <p className={`mb-4 text-sm ${muted}`}>Fund the vault · you are owner</p>
      <VaultNav vault={vault} />
      <Notice tone="warn">{plan.notice}</Notice>
      <Card title="USDC on NEAR (for NEAR payees)">
        {plan.fund.offer ? (
          <FundUsdcButton
            vault={vault}
            owner={plan.fund.owner}
            network={network}
            token={consts.usdc}
          />
        ) : (
          <p className={`text-sm ${muted}`}>{plan.fund.why}</p>
        )}
      </Card>
      <Card title="Base USDC inside NEAR Intents (for Base payees)">
        {plan.base.offer ? (
          <TopUpPanel vault={vault} owner={plan.base.owner} network={network} />
        ) : (
          <p className={`text-sm ${muted}`}>{plan.base.why}</p>
        )}
      </Card>
    </div>
  );
}
