import type { Metadata } from "next";
import { ConnectAgentPanel } from "@/components/console/ConnectAgentPanel";
import { VaultNav } from "@/components/console/VaultNav";
import { VaultOnOtherNetwork } from "@/components/console/VaultOnOtherNetwork";
import { Notice } from "@/components/ui";
import { MCP_ON_NPM } from "@/lib/agent/connect";
import { loadAgentPage } from "@/lib/agent/load";
import { requireMember } from "@/lib/auth/guard";
import { keyAllowances } from "@/lib/config";
import { safeChainText } from "@/lib/console/mandates-view";
import { OUT_OF_NEAR } from "@/lib/console/out-of-near";
import { rpcChainReads } from "@/lib/console/vaults";
import { serviceDb } from "@/lib/db/clients";
import { chainConsts, getReader, getRpc } from "@/lib/near/server";
import { removeAgentTx, type WalletTx } from "@/lib/near/tx";
import { prepareAddAgentAction, prepareSetLedgerKeyAction } from "./actions";

export const metadata: Metadata = { title: "Agent (MCP)" };
/** The wallet buttons confirm their transaction on chain (FINAL) through a server action. */
export const maxDuration = 60;

const muted = "text-mute";

// The Agent (MCP) tab: connect the user's own AI agent, whose two keys were made on its own machine. Everything here
// is read from the chain and the tenant's own rows at request time; nothing is written. The owner gets the six steps;
// an approver or a viewer gets the status card only. Mainnet and testnet run the same code: the only difference is
// the Top-up tab's test USDC link.
export default async function AgentPage({ params }: { params: Promise<{ vault: string }> }) {
  const { vault: requested } = await params;
  // 404 for anyone who is not a member: a vault id is never confirmed to a stranger.
  const { session, member, elsewhere } = await requireMember(requested);
  if (elsewhere) return <VaultOnOtherNetwork {...elsewhere} />;
  const vault = member.vault_id;
  const network = member.network;
  const data = await loadAgentPage(
    serviceDb(),
    getReader(network),
    rpcChainReads(getRpc(network)),
    member,
    chainConsts(network).usdc,
    Date.now(),
  );
  const isOwner = member.role === "owner";
  const config = data.facts.ok ? data.facts.config : null;
  // The chain decides who may sign: the membership row says owner, the contract's owner must agree.
  const chainOwner = config !== null && config.owner === session.accountId;
  const canAct = isOwner && chainOwner;
  const allowance = keyAllowances(member.kind);
  // Remove, per agent key held outside Probarion: built here, for the member's own vault, and only for the owner.
  const removeTxs: Record<string, WalletTx> = {};
  if (canAct) {
    for (const a of data.outsideAgents)
      removeTxs[a.public_key] = removeAgentTx(vault, a.public_key);
  }

  return (
    <div>
      <h1 className="mono mb-1 text-2xl font-semibold break-all">{vault}</h1>
      <p className={`mb-4 text-sm ${muted}`}>
        Connect an AI agent (MCP) &middot; you are {member.role}
      </p>
      <VaultNav vault={vault} />
      <Notice>
        Your agent&apos;s two keys are made on your own machine and stay there: Probarion never sees
        their secrets. You paste the two <b>public</b> keys here and sign two calls in your wallet.
        The vault limits the agent key to <code>spend()</code> and the ledger key to{" "}
        <code>anchor()</code>, and neither can attach a deposit, so the agent can pay only under
        mandates you sign. Works with Claude Code, Claude Desktop, Cursor and Codex.
      </Notice>
      {!data.facts.ok ? (
        <Notice tone="warn">
          The vault&apos;s keys could not be read right now, so nothing is offered here. Reload the
          page to try again.
        </Notice>
      ) : (
        <>
          {isOwner && config !== null && !chainOwner ? (
            <Notice tone="bad">
              The vault&apos;s owner on chain is {safeChainText(config.owner)}, not the account you
              are signed in as ({session.accountId}), so the vault would refuse these calls.
            </Notice>
          ) : null}
          <ConnectAgentPanel
            vault={vault}
            network={network}
            signer={session.accountId}
            isOwner={isOwner}
            canAct={canAct}
            facts={data.facts.facts}
            outsideAgents={data.outsideAgents}
            outsideLedger={data.outsideLedger}
            activeMandateKeys={data.activeMandateKeys}
            usdc={data.usdc}
            freeNear={data.freeNear}
            allowances={{
              agentYocto: allowance.agentAllowanceYocto,
              ledgerYocto: allowance.ledgerAllowanceYocto,
            }}
            testUsdc={network === "testnet"}
            onNpm={MCP_ON_NPM}
            removeTxs={removeTxs}
            outOfNearCodes={OUT_OF_NEAR.codes}
            addAgent={canAct ? prepareAddAgentAction.bind(null, vault) : undefined}
            setLedgerKey={canAct ? prepareSetLedgerKeyAction.bind(null, vault) : undefined}
          />
        </>
      )}
    </div>
  );
}
