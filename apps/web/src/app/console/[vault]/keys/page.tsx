import type { Metadata } from "next";
import {
  KeyActions,
  KeyKeepButton,
  KeySyncButton,
  KeyTxButton,
} from "@/components/console/KeyActions";
import { VaultNav } from "@/components/console/VaultNav";
import { Badge, Card, Notice, type Tone } from "@/components/ui";
import { requireMember } from "@/lib/auth/guard";
import { VAULT_DEFAULTS } from "@/lib/config";
import { OUT_OF_NEAR } from "@/lib/console/out-of-near";
import { rpcChainReads } from "@/lib/console/vaults";
import { serviceDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { DISCARDED_ON_CHAIN_TEXT, type KeyStatus, stuckText } from "@/lib/keys/rules";
import { type AllowanceView, type KeyView, loadKeysView } from "@/lib/keys/view";
import { lockKeyFor } from "@/lib/near/lock";
import { getReader, getRpc } from "@/lib/near/server";
import { addAgentTx, removeAgentTx, setLedgerKeyTx } from "@/lib/near/tx";
import { formatNear } from "@/lib/near/units";
import { discardKeyAction, generateKeyAction, keepKeyAction, syncKeysAction } from "./actions";

export const metadata: Metadata = { title: "Keys" };
/** The wallet buttons confirm their transaction on chain (FINAL) through a server action. */
export const maxDuration = 60;

const muted = "text-[#0B0B0C]/60";

const STATUS_TONE: Record<KeyStatus, Tone> = {
  pending: "warn",
  active: "good",
  revoked: "neutral",
  removed: "neutral",
};

function allowanceText(a: AllowanceView | null): string {
  if (a === null) return "—";
  switch (a.state) {
    case "limited":
      return `${formatNear(a.yocto)} NEAR`;
    case "unlimited":
      return "no limit set (this vault never adds such a key: check it)";
    case "not_on_chain":
      return "not on chain";
    case "unavailable":
      return "unavailable";
  }
}

export default async function KeysPage({ params }: { params: Promise<{ vault: string }> }) {
  const { vault: requested } = await params;
  // 404 for anyone who is not a member: a vault id is never confirmed to a stranger.
  const { session, member } = await requireMember(requested);
  const vault = member.vault_id;
  const network = getEnv().NEAR_NETWORK;
  const view = await loadKeysView(serviceDb(), getReader(), member, rpcChainReads(getRpc()));
  // A stuck ledger key can be replaced only on current vault code (W-T10-R3); on old code, or when the
  // code could not be read, a new ledger key is not offered (it could only move the stuck pointer).
  const ledgerBlocked = view.ledgerStuck && view.vaultCode !== "current";
  const isOwner = member.role === "owner";
  const sync = syncKeysAction.bind(null, vault);
  const codes = OUT_OF_NEAR.codes;

  // Owner only. A pending key can be added (unless the vault already registers it) or discarded; an
  // agent key the last sync saw registered in list_agents can be removed whatever its status here,
  // so a stuck or revoked registration can always be cleared (W-T10-R1). A discarded key that is on
  // the vault after all can be removed there or kept (W-T10-R2). While the vault's ledger key is
  // stuck on old vault code (or code that could not be read), no ledger key is offered for setting
  // (ledgerBlocked); on current code, setting a new ledger key is how it recovers.
  const ownerButtons = (k: KeyView) => {
    if (!isOwner) return null;
    const common = { network, signer: session.accountId, outOfNearCodes: codes, sync };
    const canAdd =
      k.status === "pending" && k.registered !== true && !(k.purpose === "ledger" && ledgerBlocked);
    const canRemove = k.purpose === "agent" && (k.registered === true || k.status === "active");
    return (
      <>
        {canAdd && k.purpose === "agent" ? (
          <KeyTxButton
            {...common}
            label="Add on-chain"
            tx={addAgentTx(vault, k.public_key, VAULT_DEFAULTS.agentAllowanceYocto, k.label)}
            lockKey={lockKeyFor(`keys:add:${vault}:${k.public_key}`)}
          />
        ) : null}
        {canAdd && k.purpose === "ledger" ? (
          <KeyTxButton
            {...common}
            label="Set as ledger key"
            tx={setLedgerKeyTx(vault, k.public_key, VAULT_DEFAULTS.ledgerAllowanceYocto)}
            lockKey={lockKeyFor(`keys:set-ledger:${vault}:${k.public_key}`)}
            confirm={
              view.ledgerActive
                ? "Replace the vault's ledger key with this one? The current one is removed from the vault."
                : undefined
            }
          />
        ) : null}
        {canRemove ? (
          <KeyTxButton
            {...common}
            label="Remove"
            tx={removeAgentTx(vault, k.public_key)}
            lockKey={lockKeyFor(`keys:remove:${vault}:${k.public_key}`)}
            confirm="Remove this agent key from the vault? Payables stops using it at once."
          />
        ) : null}
        {k.discardedOnChain ? <KeyKeepButton keep={keepKeyAction.bind(null, vault, k.id)} /> : null}
        {k.status === "pending" ? (
          <form action={discardKeyAction.bind(null, vault, k.id)}>
            <button type="submit" className="text-xs text-stone-600 underline">
              Discard
            </button>
          </form>
        ) : null}
      </>
    );
  };

  return (
    <div>
      <h1 className="mono mb-1 text-2xl font-semibold break-all">{vault}</h1>
      <p className={`mb-4 text-sm ${muted}`}>Agent and ledger keys · you are {member.role}</p>
      <VaultNav vault={vault} />
      <Notice>
        Probarion generates these keys on its server and stores each secret encrypted (libsodium
        secretbox; the master key is kept outside the database). You add a key to your vault from
        your own wallet, with its public key only. The vault limits it to <code>spend()</code> or{" "}
        <code>anchor()</code>, and a key like that can never attach a deposit, so it cannot move
        funds except through your mandates. Adding a key stores it on the vault, which needs a
        little free NEAR. You can remove an agent key from your wallet at any time.
      </Notice>
      <Card title="Keys" actions={<KeySyncButton sync={sync} />}>
        {view.keys.length === 0 ? (
          <p className={`text-sm ${muted}`}>No keys yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[#0B0B0C]/10">
                <th>Purpose</th>
                <th>Public key</th>
                <th>Label</th>
                <th>Status</th>
                <th>Allowance left</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {view.keys.map((k) => (
                <tr key={k.id} className="border-b border-[#0B0B0C]/10 align-top last:border-0">
                  <td>{k.purpose}</td>
                  <td className="mono text-xs break-all">{k.public_key}</td>
                  <td>{k.label}</td>
                  <td>
                    <Badge tone={STATUS_TONE[k.status]}>{k.status}</Badge>
                    {k.stuck ? (
                      <p className="mt-1 text-xs text-rose-700">
                        Stuck: this key {stuckText(k.purpose, view.vaultCode)}
                      </p>
                    ) : null}
                    {k.discardedOnChain ? (
                      <p className="mt-1 text-xs text-amber-900">
                        Discarded, but on chain: this key {DISCARDED_ON_CHAIN_TEXT[k.purpose]}
                      </p>
                    ) : null}
                  </td>
                  <td>{allowanceText(k.allowance)}</td>
                  <td>{ownerButtons(k)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className={`mt-2 text-xs ${muted}`}>
          Payables signs each payment with the agent key its mandate is bound to, so a mandate keeps
          working only while its key is active. A key becomes active only when the chain shows it on
          the vault, limited to its one method.
        </p>
      </Card>
      {isOwner ? (
        <Card title="Add keys">
          <KeyActions
            vault={vault}
            signer={session.accountId}
            network={network}
            ledgerActive={view.ledgerActive}
            ledgerStuck={view.ledgerStuck}
            vaultCode={view.vaultCode}
            outOfNearCodes={codes}
            generate={generateKeyAction.bind(null, vault)}
            sync={sync}
          />
        </Card>
      ) : null}
    </div>
  );
}
