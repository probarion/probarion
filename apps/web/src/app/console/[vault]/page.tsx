import type { Payee, SpendView, VaultConfig } from "@probarion/core";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { FirstPaymentChecklist } from "@/components/console/FirstPaymentChecklist";
import { SendNearPanel } from "@/components/console/SendNearPanel";
import { SettingsForm } from "@/components/console/SettingsForm";
import { VaultNav } from "@/components/console/VaultNav";
import { VaultOnOtherNetwork } from "@/components/console/VaultOnOtherNetwork";
import { VaultTxButton } from "@/components/console/VaultTxButton";
import { AccountLink, Badge, Card, Notice } from "@/components/ui";
import { requireMember } from "@/lib/auth/guard";
import type { Network } from "@/lib/config";
import { firstPaymentChecklist } from "@/lib/console/checklist";
import {
  heldActions,
  mandateStatusView,
  spendStatusView,
  UNAVAILABLE,
  whyUnavailable,
} from "@/lib/console/display";
import { readKeyReadiness } from "@/lib/console/key-readiness";
import { OUT_OF_NEAR } from "@/lib/console/out-of-near";
import { loadOverview, type Read, rpcChainReads } from "@/lib/console/vaults";
import { serviceDb } from "@/lib/db/clients";
import { getEnv } from "@/lib/env";
import { NEAR_LOW_ALERT_YOCTO } from "@/lib/near/runway";
import { chainConsts, getReader, getRpc } from "@/lib/near/server";
import {
  approveTx,
  freezeTx,
  rejectTx,
  unfreezeTx,
  withdrawIntentsTx,
  withdrawTx,
} from "@/lib/near/tx";
import { formatNear, formatUsdc, nsToDate } from "@/lib/near/units";
import { FAUCET_USDC, faucetConfigured } from "@/lib/topup/faucet";
import { refreshMembersAction, updateSettingsAction } from "./actions";

export const metadata: Metadata = { title: "Vault" };
/** Every wallet button here confirms through confirmTx, which waits for the transaction to be FINAL. */
export const maxDuration = 60;

const muted = "text-mute";
const DIGITS = /^(0|[1-9][0-9]*)$/;

/** A U128 of the network's USDC (6 decimals), or a plain word when it is not a decimal (never "0"). */
function usdc(units: string): string {
  return DIGITS.test(units) ? formatUsdc(units) : "unreadable";
}

/**
 * Amounts in the vault's own token. The console knows the decimals of the network's USDC only; any
 * other token is shown in raw base units and says so, never scaled by a guess.
 */
function tokenAmount(token: string, networkUsdc: string): (units: string) => string {
  if (token === networkUsdc) return (units) => `${usdc(units)} USDC`;
  return (units) =>
    `${DIGITS.test(units) ? units : "unreadable"} base units of ${token} (decimals unknown)`;
}

function hours(ns: string): string {
  const h = Number(BigInt(ns)) / 3_600_000_000_000;
  return `${Number.isInteger(h) ? h : h.toFixed(2)} h`;
}

function payeeText(p: Payee): string {
  return p.type === "near" ? p.account_id : `${p.chain}:${p.address}`;
}

function expiry(s: SpendView): string {
  if (s.held_until_ns === null || !DIGITS.test(s.held_until_ns)) return "n/a";
  return `${nsToDate(s.held_until_ns).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/** A figure, or "unavailable" with the reason beside it. Never a zero standing in for an error. */
function Figure<T>({ read, fmt }: { read: Read<T>; fmt: (v: T) => ReactNode }) {
  if (read.ok) return <>{fmt(read.value)}</>;
  return (
    <span>
      <Badge tone="warn">{UNAVAILABLE}</Badge>{" "}
      <span className={`text-xs ${muted}`}>{whyUnavailable(read.kind)}</span>
    </span>
  );
}

function Counts({
  counts,
  view,
}: {
  counts: Record<string, number>;
  view: (s: string) => { label: string };
}) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return <span className={muted}>none</span>;
  return (
    <span>
      {entries.map(([status, n]) => (
        <span key={status} className="mr-3">
          {n} {view(status).label}
        </span>
      ))}
    </span>
  );
}

const FREEZE_CONFIRM = "Freeze stops every spend and every approval until you unfreeze. Continue?";

function VaultCard({
  vault,
  config,
  network,
  isOwner,
  networkUsdc,
  amount,
  vaultNearLow,
}: {
  vault: string;
  config: VaultConfig;
  network: Network;
  isOwner: boolean;
  networkUsdc: string;
  amount: (units: string) => string;
  vaultNearLow: boolean;
}) {
  return (
    <Card
      title="Vault"
      actions={config.frozen ? <Badge tone="bad">Frozen</Badge> : <Badge tone="good">Active</Badge>}
    >
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt>Owner</dt>
        <dd>
          <AccountLink network={network} account={config.owner} />
        </dd>
        <dt>Approvers</dt>
        <dd>
          {config.approvers.length === 0
            ? "none"
            : config.approvers.map((a) => (
                <span key={a} className="mr-2">
                  <AccountLink network={network} account={a} />
                </span>
              ))}
        </dd>
        <dt>Daily backstop</dt>
        <dd>{amount(config.daily_backstop)}</dd>
        <dt>Held payments expire after</dt>
        <dd>{hours(config.held_ttl_ns)}</dd>
        <dt>Code version</dt>
        <dd>
          {config.version}
          {config.factory ? <span className={muted}> (factory {config.factory})</span> : null}
        </dd>
        <dt>Ledger key</dt>
        <dd className="mono break-all">{config.ledger_key ?? "not set"}</dd>
      </dl>
      {config.usdc !== networkUsdc ? (
        <Notice tone="warn">
          This vault&apos;s token is {config.usdc}, not this network&apos;s USDC ({networkUsdc}).
          The console does not know its decimals, so its amounts are shown in raw base units.
        </Notice>
      ) : null}
      {isOwner ? (
        <VaultTxButton
          label={config.frozen ? "Unfreeze vault" : "Freeze vault"}
          network={network}
          expectedSigner={config.owner}
          tx={config.frozen ? unfreezeTx(vault) : freezeTx(vault)}
          confirm={
            config.frozen
              ? "Unfreeze the vault? Agents can spend again within their mandates."
              : FREEZE_CONFIRM
          }
          outOfNearCodes={OUT_OF_NEAR.codes}
          vaultNearLow={vaultNearLow}
        />
      ) : (
        <p className={`mt-2 text-xs ${muted}`}>Only the owner can freeze or unfreeze this vault.</p>
      )}
    </Card>
  );
}

export default async function VaultPage({ params }: { params: Promise<{ vault: string }> }) {
  const { vault: requested } = await params;
  // 404 for anyone who is not a member: a vault id is never confirmed to a stranger.
  const { session, member, elsewhere } = await requireMember(requested);
  if (elsewhere) return <VaultOnOtherNetwork {...elsewhere} />;
  const vault = member.vault_id;
  // The vault's own network, which is the request's: nothing below reads the other one.
  const network = member.network;
  const consts = chainConsts(network);
  // "Your first agent payment" (site audit P1-8) is for the owner of an external vault. Its one extra read, the
  // console's own key rows, starts beside the chain reads and only for them; it never rejects.
  const firstRun = member.role === "owner" && member.kind === "external";
  const keys = firstRun ? readKeyReadiness(serviceDb(), member.tenant_id) : null;
  const o = await loadOverview(getReader(network), rpcChainReads(getRpc(network)), vault, {
    base: consts.allowedAssets.base,
  });
  const config = o.config.ok ? o.config.value : null;
  const isOwner = config !== null && config.owner === session.accountId;
  const isApprover = config?.approvers.includes(session.accountId) ?? false;
  // Only a NEAR balance that was read can be low; "unavailable" never suggests a top-up.
  const vaultNearLow = o.near.ok && o.near.value.low;
  const amount = tokenAmount(config?.usdc ?? consts.usdc, consts.usdc);
  const now = Date.now();
  // Shown until the first payment, when the chain agrees this account is the owner, and only for a vault in this
  // network's USDC: Mandates cannot serve any other token.
  const checklist =
    keys !== null && config !== null && isOwner && config.usdc === consts.usdc
      ? firstPaymentChecklist({
          network,
          keys: await keys,
          usdc: o.usdc,
          intentsBase: o.intentsBase,
          mandates: o.mandates,
          spends: o.spends,
          faucetUsdc:
            network === "testnet" && faucetConfigured(network, getEnv().TESTNET_FAUCET_KEY)
              ? FAUCET_USDC
              : null,
        })
      : null;

  return (
    <div>
      <h1 className="mono mb-1 text-2xl font-semibold break-all">{vault}</h1>
      <p className={`mb-4 text-sm ${muted}`}>
        {member.display_name ? `${member.display_name} · ` : ""}you are {member.role}
        {member.kind !== "external" ? ` · ${member.kind} vault` : ""}
      </p>
      <VaultNav vault={vault} />
      {checklist !== null ? <FirstPaymentChecklist vault={vault} checklist={checklist} /> : null}

      {config === null ? (
        <>
          <Notice tone="bad">
            The vault&apos;s config could not be read (
            {o.config.ok ? "" : whyUnavailable(o.config.kind)}), so nothing about its state is
            shown. Reload to try again. The vault itself is not affected.
          </Notice>
          {/* W-T8-R1: the emergency stop must not depend on a read. The membership row says who the
              owner is (it is the on-chain owner, checked at registration); the contract checks again. */}
          {member.role === "owner" ? (
            <Card title="Emergency stop">
              <p className={`text-sm ${muted}`}>
                Freezing does not need the config: it stops every spend and every approval. Unfreeze
                needs the vault&apos;s state, so it waits until the config reads again.
              </p>
              <VaultTxButton
                label="Freeze vault"
                network={network}
                expectedSigner={session.accountId}
                tx={freezeTx(member.vault_id)}
                confirm={FREEZE_CONFIRM}
                outOfNearCodes={OUT_OF_NEAR.codes}
                vaultNearLow={false}
              />
            </Card>
          ) : null}
        </>
      ) : (
        <>
          <VaultCard
            vault={vault}
            config={config}
            network={network}
            isOwner={isOwner}
            networkUsdc={consts.usdc}
            amount={amount}
            vaultNearLow={vaultNearLow}
          />

          <Card title="Balances">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
              <dt>{config.usdc === consts.usdc ? "USDC on NEAR" : "Token on NEAR"}</dt>
              <dd>
                <Figure read={o.usdc} fmt={amount} />
              </dd>
              <dt>Base USDC in Intents</dt>
              <dd>
                <Figure read={o.intentsBase} fmt={(v) => `${usdc(v)} USDC`} />
              </dd>
              <dt>NEAR runway</dt>
              <dd>
                <Figure
                  read={o.near}
                  fmt={(r) => (
                    <span className={r.low ? "rounded bg-wait-bg px-1 text-wait" : undefined}>
                      {formatNear(r.freeYocto)} NEAR free, about {r.spends} paid spends
                      {r.alert
                        ? ` (below ${formatNear(NEAR_LOW_ALERT_YOCTO.toString())} NEAR: spends will soon fail with LackBalanceForState)`
                        : r.low
                          ? " (low: top it up)"
                          : ""}
                    </span>
                  )}
                />
              </dd>
            </dl>
            {isOwner && o.usdc.ok && /^[1-9][0-9]*$/.test(o.usdc.value) ? (
              <VaultTxButton
                label={`Withdraw all ${amount(o.usdc.value)} to my wallet`}
                network={network}
                expectedSigner={config.owner}
                tx={withdrawTx(vault, o.usdc.value)}
                confirm={`Withdraw the vault's whole balance on NEAR (${amount(o.usdc.value)}) to ${config.owner}?`}
                outOfNearCodes={OUT_OF_NEAR.codes}
                vaultNearLow={vaultNearLow}
              />
            ) : null}
            {isOwner && o.intentsBase.ok && /^[1-9][0-9]*$/.test(o.intentsBase.value) ? (
              <VaultTxButton
                label={`Withdraw all ${usdc(o.intentsBase.value)} Base USDC out of Intents to my account`}
                network={network}
                expectedSigner={config.owner}
                tx={withdrawIntentsTx(vault, consts.allowedAssets.base, o.intentsBase.value)}
                confirm={`Withdraw the vault's whole Base USDC balance (${usdc(o.intentsBase.value)}) from ${config.intents} to ${config.owner}?`}
                outOfNearCodes={OUT_OF_NEAR.codes}
                vaultNearLow={vaultNearLow}
              />
            ) : null}
            <SendNearPanel
              vault={vault}
              network={network}
              signer={session.accountId}
              outOfNearCodes={OUT_OF_NEAR.codes}
            />
          </Card>

          <Card
            title={
              o.spends.ok
                ? `Held for approval (${o.spends.value.held.length})`
                : "Held for approval"
            }
          >
            {!o.spends.ok ? (
              <Notice tone="warn">
                The spend list is {UNAVAILABLE} ({whyUnavailable(o.spends.kind)}). Payments may be
                waiting for approval: check again before you assume there are none.
              </Notice>
            ) : o.spends.value.held.length === 0 ? (
              <p className={`text-sm ${muted}`}>Nothing waiting.</p>
            ) : (
              o.spends.value.held.map((s) => {
                const act = heldActions(s.held_until_ns, config.frozen, now);
                return (
                  <div key={s.id} className="mb-3 border-b border-line pb-3 text-sm last:border-0">
                    <div>
                      Spend #{s.id} · mandate #{s.mandate_id} · <strong>{amount(s.amount)}</strong>{" "}
                      to <span className="mono break-all">{payeeText(s.destination)}</span>
                    </div>
                    <div className={`text-xs ${muted}`}>
                      ref <span className="mono">{s.ref}</span> · hold ends {expiry(s)}
                    </div>
                    {act.note ? <p className="text-xs text-wait">{act.note}</p> : null}
                    {isApprover ? (
                      <div className="mt-3 flex flex-wrap gap-3">
                        {act.canApprove ? (
                          <VaultTxButton
                            label="Approve"
                            network={network}
                            expectedSigner={session.accountId}
                            tx={approveTx(vault, s.id)}
                            confirm={`Approve paying ${amount(s.amount)} to ${payeeText(s.destination)} (spend #${s.id})?`}
                            outOfNearCodes={OUT_OF_NEAR.codes}
                            vaultNearLow={vaultNearLow}
                          />
                        ) : null}
                        <VaultTxButton
                          label="Reject"
                          network={network}
                          expectedSigner={session.accountId}
                          tx={rejectTx(vault, s.id)}
                          confirm={`Reject spend #${s.id}? Its reservation goes back to the mandate.`}
                          confirmTone="danger"
                          outOfNearCodes={OUT_OF_NEAR.codes}
                          vaultNearLow={vaultNearLow}
                        />
                      </div>
                    ) : (
                      <p className={`text-xs ${muted}`}>
                        Only the vault&apos;s approvers can approve or reject.
                      </p>
                    )}
                  </div>
                );
              })
            )}
          </Card>

          <Card title="Mandates and spends">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
              <dt>Mandates</dt>
              <dd>
                <Figure
                  read={o.mandates}
                  fmt={(m) => (
                    <>
                      {m.total} in all: <Counts counts={m.counts} view={mandateStatusView} />
                    </>
                  )}
                />
              </dd>
              <dt>Spends</dt>
              <dd>
                <Figure
                  read={o.spends}
                  fmt={(s) => (
                    <>
                      {s.total} in all: <Counts counts={s.counts} view={spendStatusView} />
                    </>
                  )}
                />
              </dd>
            </dl>
          </Card>

          <Card title="Recent spends">
            {!o.spends.ok ? (
              <p className={`text-sm ${muted}`}>
                {UNAVAILABLE}: {whyUnavailable(o.spends.kind)}
              </p>
            ) : o.spends.value.recent.length === 0 ? (
              <p className={`text-sm ${muted}`}>No spends yet.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th>#</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>To</th>
                    <th>Ref</th>
                  </tr>
                </thead>
                <tbody>
                  {o.spends.value.recent.map((s) => {
                    const v = spendStatusView(s.status);
                    return (
                      <tr key={s.id} className="border-b border-line last:border-0">
                        <td>{s.id}</td>
                        <td>{amount(s.amount)}</td>
                        <td>
                          <Badge tone={v.tone}>{v.label}</Badge>
                        </td>
                        <td className="mono break-all">{payeeText(s.destination)}</td>
                        <td className="mono break-all">{s.ref}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      {member.role === "owner" ? (
        <Card title="Settings">
          <SettingsForm
            vault={vault}
            kind={member.kind}
            zeroRetention={member.zero_retention}
            proofPublic={member.proof_public}
            save={updateSettingsAction.bind(null, vault)}
            refresh={refreshMembersAction.bind(null, vault)}
          />
        </Card>
      ) : null}
    </div>
  );
}
