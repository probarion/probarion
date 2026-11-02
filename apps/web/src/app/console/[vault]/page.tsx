import type { Payee, SpendView, VaultConfig } from "@probarion/core";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SendNearPanel } from "@/components/console/SendNearPanel";
import { SettingsForm } from "@/components/console/SettingsForm";
import { VaultNav } from "@/components/console/VaultNav";
import { VaultTxButton } from "@/components/console/VaultTxButton";
import { AccountLink, Badge, Card, Notice } from "@/components/ui";
import { requireMember } from "@/lib/auth/guard";
import type { Network } from "@/lib/config";
import {
  heldActions,
  mandateStatusView,
  spendStatusView,
  UNAVAILABLE,
  whyUnavailable,
} from "@/lib/console/display";
import { OUT_OF_NEAR } from "@/lib/console/out-of-near";
import { loadOverview, type Read, rpcChainReads } from "@/lib/console/vaults";
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
import { refreshMembersAction, updateSettingsAction } from "./actions";

export const metadata: Metadata = { title: "Vault" };

const muted = "text-[#0B0B0C]/60";

/** A U128 from the chain, formatted, or a plain word when it is not a decimal (never a crash, never "0"). */
function usdc(units: string): string {
  return /^(0|[1-9][0-9]*)$/.test(units) ? formatUsdc(units) : "unreadable";
}

function hours(ns: string): string {
  const h = Number(BigInt(ns)) / 3_600_000_000_000;
  return `${Number.isInteger(h) ? h : h.toFixed(2)} h`;
}

function payeeText(p: Payee): string {
  return p.type === "near" ? p.account_id : `${p.chain}:${p.address}`;
}

function expiry(s: SpendView): string {
  if (s.held_until_ns === null || !/^[0-9]+$/.test(s.held_until_ns)) return "n/a";
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

function VaultCard({
  vault,
  config,
  network,
  isOwner,
  networkUsdc,
}: {
  vault: string;
  config: VaultConfig;
  network: Network;
  isOwner: boolean;
  networkUsdc: string;
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
        <dd>{usdc(config.daily_backstop)} USDC</dd>
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
          Its balance below is of its own token.
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
              : "Freeze stops every spend and every approval until you unfreeze. Continue?"
          }
          outOfNear={OUT_OF_NEAR}
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
  const { session, member } = await requireMember(requested);
  const vault = member.vault_id;
  const network = getEnv().NEAR_NETWORK;
  const consts = chainConsts();
  const o = await loadOverview(getReader(), rpcChainReads(getRpc()), vault, {
    base: consts.allowedAssets.base,
  });
  const config = o.config.ok ? o.config.value : null;
  const isOwner = config !== null && config.owner === session.accountId;
  const isApprover = config?.approvers.includes(session.accountId) ?? false;
  const now = Date.now();

  return (
    <div>
      <h1 className="mono mb-1 text-2xl font-semibold break-all">{vault}</h1>
      <p className={`mb-4 text-sm ${muted}`}>
        {member.display_name ? `${member.display_name} · ` : ""}you are {member.role}
        {member.kind !== "external" ? ` · ${member.kind} vault` : ""}
      </p>
      <VaultNav vault={vault} />

      {config === null ? (
        <Notice tone="bad">
          The vault&apos;s config could not be read (
          {o.config.ok ? "" : whyUnavailable(o.config.kind)}), so nothing about its state is shown.
          Reload to try again. The vault itself is not affected.
        </Notice>
      ) : (
        <>
          <VaultCard
            vault={vault}
            config={config}
            network={network}
            isOwner={isOwner}
            networkUsdc={consts.usdc}
          />

          <Card title="Balances">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
              <dt>USDC on NEAR</dt>
              <dd>
                <Figure read={o.usdc} fmt={(v) => `${usdc(v)} USDC`} />
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
                    <span
                      className={r.low ? "rounded bg-amber-100 px-1 text-amber-900" : undefined}
                    >
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
                label={`Withdraw all ${usdc(o.usdc.value)} USDC to my wallet`}
                network={network}
                expectedSigner={config.owner}
                tx={withdrawTx(vault, o.usdc.value)}
                confirm={`Withdraw the vault's whole USDC balance on NEAR (${usdc(o.usdc.value)} USDC) to ${config.owner}?`}
                outOfNear={OUT_OF_NEAR}
              />
            ) : null}
            {isOwner && o.intentsBase.ok && /^[1-9][0-9]*$/.test(o.intentsBase.value) ? (
              <VaultTxButton
                label={`Withdraw all ${usdc(o.intentsBase.value)} Base USDC out of Intents to my account`}
                network={network}
                expectedSigner={config.owner}
                tx={withdrawIntentsTx(vault, consts.allowedAssets.base, o.intentsBase.value)}
                confirm={`Withdraw the vault's whole Base USDC balance (${usdc(o.intentsBase.value)}) from ${config.intents} to ${config.owner}?`}
                outOfNear={OUT_OF_NEAR}
              />
            ) : null}
            <SendNearPanel vault={vault} network={network} signer={session.accountId} />
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
                  <div
                    key={s.id}
                    className="mb-3 border-b border-[#0B0B0C]/10 pb-3 text-sm last:border-0"
                  >
                    <div>
                      Spend #{s.id} · mandate #{s.mandate_id} ·{" "}
                      <strong>{usdc(s.amount)} USDC</strong> to{" "}
                      <span className="mono break-all">{payeeText(s.destination)}</span>
                    </div>
                    <div className={`text-xs ${muted}`}>
                      ref <span className="mono">{s.ref}</span> · hold ends {expiry(s)}
                    </div>
                    {act.note ? <p className="text-xs text-amber-900">{act.note}</p> : null}
                    {isApprover ? (
                      <div className="flex flex-wrap gap-4">
                        {act.canApprove ? (
                          <VaultTxButton
                            label="Approve"
                            network={network}
                            expectedSigner={session.accountId}
                            tx={approveTx(vault, s.id)}
                            confirm={`Approve paying ${usdc(s.amount)} USDC to ${payeeText(s.destination)} (spend #${s.id})?`}
                            outOfNear={OUT_OF_NEAR}
                          />
                        ) : null}
                        <VaultTxButton
                          label="Reject"
                          network={network}
                          expectedSigner={session.accountId}
                          tx={rejectTx(vault, s.id)}
                          confirm={`Reject spend #${s.id}? Its reservation goes back to the mandate.`}
                          outOfNear={OUT_OF_NEAR}
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
                  <tr className="border-b border-[#0B0B0C]/10">
                    <th>#</th>
                    <th>Amount (USDC)</th>
                    <th>Status</th>
                    <th>To</th>
                    <th>Ref</th>
                  </tr>
                </thead>
                <tbody>
                  {o.spends.value.recent.map((s) => {
                    const v = spendStatusView(s.status);
                    return (
                      <tr key={s.id} className="border-b border-[#0B0B0C]/10 last:border-0">
                        <td>{s.id}</td>
                        <td>{usdc(s.amount)}</td>
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
