import type { MandateView } from "@probarion/core";
import type { Metadata } from "next";
import Link from "next/link";
import { MandateFormPanel } from "@/components/console/MandateFormPanel";
import { RevokeMandateButton } from "@/components/console/RevokeMandateButton";
import { VaultNav } from "@/components/console/VaultNav";
import { VaultOnOtherNetwork } from "@/components/console/VaultOnOtherNetwork";
import { AccountLink, Badge, Card, Notice } from "@/components/ui";
import { requireMember } from "@/lib/auth/guard";
import type { Network } from "@/lib/config";
import { type FloatRead, floatFromRead } from "@/lib/console/mandates";
import {
  DIGITS,
  expiryText,
  mandateState,
  type PayeeView,
  payeeView,
  purposeShort,
  purposeTitle,
  remainingUnits,
  safeChainText,
  usdcText,
} from "@/lib/console/mandates-view";
import { OUT_OF_NEAR } from "@/lib/console/out-of-near";
import { isVaultConfig, type Read } from "@/lib/console/vaults";
import { log } from "@/lib/log";
import { chainErrorKind, listAll } from "@/lib/near/reader";
import { chainConsts, getReader } from "@/lib/near/server";
import { revokeMandateTx, type WalletTx } from "@/lib/near/tx";

export const metadata: Metadata = { title: "Mandates" };
/** The wallet buttons here confirm their transaction on chain (FINAL), which can take a while. */
export const maxDuration = 60;

const muted = "text-mute";

/** One chain read, kept apart from the others: a failure is "unavailable" for that part only, never an empty list or a zero. */
async function attempt<T>(what: string, vault: string, run: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    const kind = chainErrorKind(e) ?? "error";
    log.warn("console.read_failed", { what, vault, kind });
    return { ok: false, kind };
  }
}

/** A list of agent keys as the contract's `list_agents` returns them, or null when it is anything else. */
function agentList(value: unknown): { public_key: string; label: string }[] | null {
  if (!Array.isArray(value)) return null;
  const out: { public_key: string; label: string }[] = [];
  for (const a of value) {
    if (typeof a !== "object" || a === null) return null;
    const { public_key, label } = a as Record<string, unknown>;
    if (typeof public_key !== "string" || public_key === "") return null;
    out.push({ public_key, label: typeof label === "string" ? label : "" });
  }
  return out;
}

function payeeText(v: PayeeView): string {
  switch (v.kind) {
    case "near":
      return v.account;
    case "intents":
      return `${v.chain === "base" ? "Base" : "Solana"} ${v.address}`;
    case "unreadable":
      return v.text;
  }
}

function PayeeCell({ view, network }: { view: PayeeView; network: Network }) {
  if (view.kind === "near") {
    return <AccountLink network={network} account={view.account} />;
  }
  if (view.kind === "intents") {
    return (
      <span className="mono break-all">
        <span className={muted}>{view.chain === "base" ? "Base " : "Solana "}</span>
        {view.address}
      </span>
    );
  }
  return (
    <span>
      <Badge tone="warn">unreadable</Badge> <span className="mono break-all">{view.text}</span>
    </span>
  );
}

/** A revoke transaction for a mandate id the chain gave, or null when the id is not one the builder takes. */
function revokeTx(vault: string, id: number): WalletTx | null {
  try {
    return revokeMandateTx(vault, id);
  } catch {
    return null;
  }
}

export default async function MandatesPage({ params }: { params: Promise<{ vault: string }> }) {
  const { vault: requested } = await params;
  // 404 for anyone who is not a member: a vault id is never confirmed to a stranger.
  const { session, member, elsewhere } = await requireMember(requested);
  if (elsewhere) return <VaultOnOtherNetwork {...elsewhere} />;
  const vault = member.vault_id;
  const network = member.network;
  const consts = chainConsts(network);
  const reader = getReader(network);
  const isOwner = member.role === "owner";

  const [configRead, agentsRead, mandatesRead] = await Promise.all([
    attempt("get_config", vault, () => reader.getConfig(vault)),
    attempt("list_agents", vault, () => reader.listAgents(vault)),
    attempt("list_mandates", vault, () =>
      listAll((from, limit) => reader.listMandates(vault, from, limit)),
    ),
  ]);
  const config = configRead.ok && isVaultConfig(configRead.value) ? configRead.value : null;
  // Anything but a list of keys is "unavailable", not an empty list.
  const agents = agentsRead.ok ? agentList(agentsRead.value) : null;
  const mandates: MandateView[] | null = mandatesRead.ok ? mandatesRead.value : null;
  const networkUsdc = config !== null && config.usdc === consts.usdc;
  // The chain decides who may sign: the membership row says owner, the contract's owner must agree.
  const chainOwner = config !== null && config.owner === session.accountId;
  // Creating and revoking need both: the role in our records and the owner the contract will accept.
  const canAct = isOwner && chainOwner;

  // R3: what the vault holds to pay from, only needed for the form.
  const canForm = canAct && networkUsdc && agents !== null && agents.length > 0;
  let floats: { near: FloatRead; base: FloatRead } = {
    near: { ok: false },
    base: { ok: false },
  };
  if (canForm && config !== null) {
    const [near, base] = await Promise.all([
      attempt("ft_balance_of", vault, () => reader.ftBalance(config.usdc, vault)),
      config.allowed_assets.includes(consts.allowedAssets.base)
        ? attempt("mt_balance_of", vault, () =>
            reader.intentsBalance(config.intents, vault, consts.allowedAssets.base),
          )
        : Promise.resolve<Read<string>>({ ok: false, kind: "not_allowed" }),
    ]);
    floats = { near: floatFromRead(near), base: floatFromRead(base) };
  }

  const nowMs = Date.now();
  // Amounts are USDC (6 decimals) only for the network's USDC; any other token is shown in base units.
  const amount = (units: string) =>
    networkUsdc
      ? `${usdcText(units)} USDC`
      : `${DIGITS.test(units) ? units : "unreadable"} base units (decimals unknown)`;

  return (
    <div>
      <h1 className="mono mb-1 text-2xl font-semibold break-all">{vault}</h1>
      <p className={`mb-4 text-sm ${muted}`}>
        {member.display_name ? `${member.display_name} · ` : ""}you are {member.role}
      </p>
      <VaultNav vault={vault} />

      {config !== null && !networkUsdc ? (
        <Notice tone="warn">
          This vault&apos;s token is {safeChainText(config.usdc)}, not this network&apos;s USDC. The
          console does not know its decimals, so amounts are shown in base units and mandates are
          not created here.
        </Notice>
      ) : null}
      {config === null ? (
        <Notice tone="warn">
          The vault&apos;s config is unavailable, so its token and owner could not be checked.
          Amounts are shown in base units, and mandates cannot be created until it reads again.
        </Notice>
      ) : null}

      <Card title={mandates ? `Mandates (${mandates.length})` : "Mandates"}>
        {mandates === null ? (
          <Notice tone="warn">
            The mandate list is unavailable (the vault could not be read). It is not empty: reload
            to try again.
          </Notice>
        ) : mandates.length === 0 ? (
          <p className={`text-sm ${muted}`}>
            No mandates yet. An agent cannot pay anyone without one.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th>#</th>
                  <th>Name</th>
                  <th>Pays</th>
                  <th>Remaining / total</th>
                  <th>Per payment</th>
                  <th>Payments</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mandates.map((m) => {
                  const state = mandateState(m, nowMs);
                  const view = payeeView(m.payee);
                  const left = remainingUnits(m);
                  const label = safeChainText(m.label) || "(no name)";
                  const tx = canAct && state.canRevoke ? revokeTx(vault, m.id) : null;
                  const held =
                    /^[0-9]+$/.test(m.approval_above) &&
                    /^[0-9]+$/.test(m.max_per_payment) &&
                    BigInt(m.approval_above) < BigInt(m.max_per_payment);
                  return (
                    <tr key={m.id} className="border-b border-line align-top last:border-0">
                      <td>{m.id}</td>
                      <td>
                        {label}
                        <div
                          className={`mono text-xs ${muted}`}
                          title={purposeTitle(m.purpose_hash)}
                        >
                          PO {purposeShort(m.purpose_hash)}
                        </div>
                      </td>
                      <td>
                        <PayeeCell view={view} network={network} />
                      </td>
                      <td>
                        <strong>{left === null ? "unreadable" : amount(left)}</strong> of{" "}
                        {amount(m.max_total)}
                        <div className={`text-xs ${muted}`}>
                          paid {amount(m.spent)}
                          {m.reserved !== "0" ? ` · reserved ${amount(m.reserved)}` : ""}
                        </div>
                      </td>
                      <td>
                        {amount(m.max_per_payment)}
                        {held ? (
                          <div className={`text-xs ${muted}`}>
                            held above {amount(m.approval_above)}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {m.uses}/{m.max_uses}
                      </td>
                      <td>{expiryText(m.expires_at_ns)}</td>
                      <td>
                        <Badge tone={state.tone}>{state.label}</Badge>
                      </td>
                      <td>
                        {tx !== null ? (
                          <RevokeMandateButton
                            vault={vault}
                            mandateId={m.id}
                            mandateLabel={label}
                            payeeText={payeeText(view)}
                            note={state.revokeNote}
                            network={network}
                            signer={session.accountId}
                            tx={tx}
                            outOfNearCodes={OUT_OF_NEAR.codes}
                          />
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {!isOwner ? (
        <p className={`text-xs ${muted}`}>
          Only the vault&apos;s owner can create or revoke mandates.
        </p>
      ) : (
        <Card title="New mandate">
          {config === null ? (
            <Notice tone="warn">
              Unavailable while the vault&apos;s config cannot be read. Reload to try again.
            </Notice>
          ) : !chainOwner ? (
            <Notice tone="bad">
              The vault&apos;s owner on chain is {safeChainText(config.owner)}, not the account you
              are signed in as ({session.accountId}), so the vault would refuse a mandate or a
              revoke from you.
            </Notice>
          ) : !networkUsdc ? (
            <Notice tone="warn">
              Mandates are not created for a vault whose token is not this network&apos;s USDC.
            </Notice>
          ) : agents === null ? (
            <Notice tone="warn">
              The vault&apos;s agent keys are unavailable, so a mandate cannot be created now.
              Reload to try again.
            </Notice>
          ) : agents.length === 0 ? (
            <Notice tone="info">
              A mandate belongs to one agent key, and this vault has none yet. Add one on the{" "}
              <Link className="underline" href={`/console/${encodeURIComponent(vault)}/keys`}>
                Keys tab
              </Link>{" "}
              first.
            </Notice>
          ) : (
            <MandateFormPanel
              vault={vault}
              owner={config.owner}
              network={network}
              baseAsset={consts.allowedAssets.base}
              allowedAssets={config.allowed_assets}
              protocolAccounts={[config.usdc, config.intents, ...config.allowed_assets]}
              agentKeys={agents.map((a) => ({
                public_key: a.public_key,
                label: safeChainText(a.label, 40) || safeChainText(a.public_key, 20),
              }))}
              dailyBackstop={config.daily_backstop}
              floats={floats}
              outOfNearCodes={OUT_OF_NEAR.codes}
            />
          )}
        </Card>
      )}
    </div>
  );
}
