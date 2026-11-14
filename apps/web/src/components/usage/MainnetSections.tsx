import { Fragment, type ReactNode } from "react";
import c from "@/components/site/canary.module.css";
import { ScrollRegion } from "@/components/site/ScrollRegion";
import u from "@/components/site/usage.module.css";
import { brandCardClass, ExternalLink } from "@/components/ui";
import { thousands, utcMinute } from "@/lib/canary/format";
import { explorerTxUrl } from "@/lib/config";
import {
  BRIDGE_FEES,
  GAS,
  type GasCost,
  MAINNET_RECORD,
  type MainnetRecord,
  type MainnetRow,
  repoFile,
  SOURCES,
  TESTNET_DEPOSIT,
  type VaultDeposit,
} from "./evidence";
import { Tile } from "./UsageSections";

// The two cards of /usage that come from the committed evidence and not from the database: what the mainnet vault has
// done with real USDC, and what a spend costs. They show the same whether or not the database can be read, and add
// nothing to its counts.

/** What each refusal code means, in the words of the row. A code with no entry is shown alone. */
const REFUSAL_MEANING: Readonly<Record<string, string>> = {
  NoMandate: "the spend named a mandate that does not exist",
  OverPerPayment: "the amount was above the mandate's cap per payment",
  Frozen: "the vault was frozen",
};

/**
 * What a refusal of the team's drill of 2026-11-14 adds to its row, by its key in docs/mainnet-proof.json: that the team
 * rehearsed it, and that both spends were over mandate 1's cap (docs/evidence/mainnet-v0/drill-2026-11-14).
 */
const DRILL_NOTE: Readonly<Record<string, string>> = {
  v0_drill_over_cap: "In a drill the team rehearsed: 50 USDC on a mandate of 1 USDC a payment.",
  v0_drill_frozen_refused:
    "In a drill the team rehearsed: 2 USDC, also over the 1 USDC cap, so it could not have paid even if the vault had not been frozen.",
};

export const MAINNET_COPY = {
  tag: "Real USDC · NEAR mainnet",
  title: (vault: string) => `Mainnet (${vault})`,
  lede: "What the mainnet vault has done so far, read from the committed record. Every transaction here is a test by the owner, and every payment went to the owner's own accounts: a NEAR account and one Base address. The contract is unaudited, so the amounts are small on purpose.",
  tiles: {
    payments: "Payments",
    paymentsSub: (base: number) => `${thousands(base)} of them to Base`,
    refused: "Refused on chain",
    refusedSub: "no USDC moved",
    decisions: "Attested decisions",
    decisionsSub: (paid: number, refused: number) =>
      `${thousands(paid)} led to a payment, ${thousands(refused)} were false refusals`,
  },
  /** Two columns, so that a phone shows each transaction: the day and the transactions sit in the row's header. */
  table: {
    label: "Mainnet payments and refusals",
    what: "What (UTC day)",
    amount: "Amount",
  },
  /** A sentence around a link: the text before it, the link's own words, and the text after it. */
  attested: [
    "An attested decision carries the model's TEE evidence from NEAR AI Cloud. verify passed A1 to A8 on all of them, and on 2026-11-13",
    "the online check",
    "passed O1 (Intel TDX) and O2 (NVIDIA NRAS). The TEE measurement is not pinned, so this does not show which model image ran.",
  ],
  falseRefusals: [
    "The two refused decisions were false: on 2026-11-13 both models proposed the right amount and Base address, and a payee rule that was too strict for a Base payee refused them. Nothing was sent, and PR #142 changed the rule after the run (see",
    "the S1 record",
    ").",
  ],
  /** Before the anchor transactions of the refused decisions. */
  anchored: "Each is a signed entry in the vault's ledger, anchored on chain:",
  source: (updated: string) => [
    "From",
    "docs/mainnet-proof.json",
    `, updated ${utcMinute(updated)} UTC, as of the page's build. It is not added into the counts below.`,
  ],
} as const;

export const COSTS_COPY = {
  title: "What it costs",
  lede: "Each figure links the record it comes from. Nothing is converted to dollars.",
  /** Two columns, so that a phone shows each link: a figure links its file, or its files follow it. */
  table: { label: "What a spend costs", cost: "Cost", amount: "Amount" },
  gasLabel: (row: MainnetRow) =>
    row.kind === "refused_on_chain"
      ? "Gas, a spend refused on chain"
      : `Gas, spend ${row.spendId} (${row.kind === "base_payout" ? "a payout to Base" : "a payment on NEAR"})`,
  gasNear: (g: GasCost) => `${g.near} NEAR`,
  gasTgas: (g: GasCost) => `(${g.tgas} Tgas)`,
  bridge: (payouts: number) =>
    payouts === 1
      ? "Bridge fee, the payout to Base"
      : `Bridge fee, each of ${thousands(payouts)} payouts to Base`,
  bridgeAmount: (usdc: string) => `${usdc} USDC`,
  probarion: "Probarion fee",
  probarionAmount: "none: the contract has no fee path",
  deposit: "Vault deposit, testnet",
  depositAmount: (near: string) => `${near} test NEAR`,
  gasNote: (readOn: string) =>
    `Gas is burned in NEAR by the vault account, summed over each transaction and all its receipts, read from an archival node on ${readOn}. A spend also leaves its record in the vault's storage, paid from the vault's own NEAR, which these figures leave out.`,
  feeNote:
    "The contract takes no fee: a spend moves the full amount toward the mandate's payee and pays no one else. On a payout to Base, the POA bridge keeps its fee from that amount when it releases the USDC on Base.",
  depositNote: (minDeposit: string) =>
    `The deposit is what the console asks to create a vault on testnet: the factory's ${minDeposit} NEAR min_deposit plus the console's estimate of the storage for the vault's copy of the code. It stays in the vault. There is no mainnet figure: the mainnet factory is not deployed.`,
} as const;

const T = MAINNET_COPY.table;
const K = COSTS_COPY.table;

const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);
/** Kept on one line, so that a short hash does not break at its ellipsis. */
const explorerLink =
  "mono whitespace-nowrap text-ink underline decoration-ink/60 underline-offset-2 hover:decoration-ink";

/** A transaction on an explorer, in a new tab, named by its short form. */
function Explorer({ href, hash }: { href: string; hash: string }) {
  return (
    <ExternalLink className={explorerLink} href={href}>
      {short(hash)}
    </ExternalLink>
  );
}

/** A repository file, opened on GitHub, named by its last part. */
function Source({ path, label }: { path: string; label?: string }) {
  return (
    <ExternalLink className={c.link} href={repoFile(path)}>
      {label ?? path.split("/").at(-1)?.split("#")[0]}
    </ExternalLink>
  );
}

/** A sentence with one link in it, from its three parts. The text after the link follows a space unless it is punctuation. */
function Linked({ parts, path }: { parts: readonly string[]; path: string }) {
  const [before = "", words = "", after = ""] = parts;
  return (
    <>
      {before} <Source path={path} label={words} />
      {/^[,.;:)]/.test(after) ? after : ` ${after}`}
    </>
  );
}

function decided(row: MainnetRow): string {
  if (row.decidedBy === "model+rules") {
    return `Decided by an attested model (${row.model}) and the code rules.`;
  }
  if (row.decidedBy === "rules-only") return "Decided by the code rules alone.";
  return row.beforeLedger ? "Made before the vault's signed ledger began." : "";
}

function what(row: MainnetRow): string {
  if (row.kind === "refused_on_chain") {
    const meaning = row.errorCode ? REFUSAL_MEANING[row.errorCode] : undefined;
    const drill = DRILL_NOTE[row.key];
    return `Refused on chain with ${row.errorCode}${meaning ? `: ${meaning}` : ""}.${drill ? ` ${drill}` : ""} No USDC moved.`;
  }
  const where =
    row.kind === "base_payout" ? "a payout to Base through NEAR Intents" : "a payment on NEAR";
  return `Spend ${row.spendId}, ${where}. ${decided(row)}`.trim();
}

/** What the row moved: nothing for a refusal, whatever amount it asked for. To Base, also what arrived after the fee. */
function amount(row: MainnetRow): ReactNode {
  if (row.kind === "refused_on_chain" || row.amount === null) return "none";
  if (row.arrived === null) return `${row.amount} USDC`;
  return (
    <>
      {row.amount} USDC sent,
      <br />
      {row.arrived} USDC arrived
    </>
  );
}

/** The mainnet vault's payments, refusals on chain and attested decisions, each with its transactions. */
export function MainnetRecordCard({ record = MAINNET_RECORD }: { record?: MainnetRecord }) {
  const C = MAINNET_COPY;
  const anchors = record.decisions.flatMap((d) =>
    d.verdict === "refuse" && d.anchorTx !== null ? [d.anchorTx] : [],
  );
  return (
    <section id="mainnet" className={brandCardClass}>
      <p className={c.tag}>{C.tag}</p>
      <h2 className={c.cardTitle}>{C.title(record.vault)}</h2>
      <p className="max-w-measure">{C.lede}</p>
      <div className={`${c.tiles} mt-6`}>
        <Tile
          label={C.tiles.payments}
          value={record.payments}
          sub={C.tiles.paymentsSub(record.basePayouts)}
        />
        <Tile label={C.tiles.refused} value={record.refusedOnChain} sub={C.tiles.refusedSub} />
        <Tile
          label={C.tiles.decisions}
          value={record.decisions.length}
          sub={C.tiles.decisionsSub(record.decisionsPaid, record.decisionsRefused)}
        />
      </div>
      <ScrollRegion label={T.label} className={c.scroll}>
        <table className={`${c.table} ${u.usage}`}>
          <thead>
            <tr>
              <th scope="col">{T.what}</th>
              <th scope="col">{T.amount}</th>
            </tr>
          </thead>
          <tbody>
            {record.rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">
                  <span className={c.quiet}>{row.day}</span>
                  <br />
                  {what(row)}
                  <br />
                  <span className="whitespace-nowrap">
                    NEAR <Explorer href={explorerTxUrl("mainnet", row.nearTx)} hash={row.nearTx} />
                  </span>
                  {row.baseTx === null ? null : (
                    <>
                      <br />
                      <span className="whitespace-nowrap">
                        Base{" "}
                        <Explorer
                          href={`https://basescan.org/tx/${row.baseTx}`}
                          hash={row.baseTx}
                        />
                      </span>
                    </>
                  )}
                </th>
                <td>{amount(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <p className={c.line}>
        <Linked parts={C.attested} path={SOURCES.verifyOnline} />
      </p>
      {record.decisionsRefused > 0 ? (
        <p className={c.line}>
          <Linked parts={C.falseRefusals} path={SOURCES.s1FalseRefusals} />
          {anchors.length > 0 ? (
            <>
              {" "}
              {C.anchored}{" "}
              {anchors.map((hash, i) => (
                <Fragment key={hash}>
                  {i === 0 ? null : i === anchors.length - 1 ? " and " : ", "}
                  <Explorer href={explorerTxUrl("mainnet", hash)} hash={hash} />
                </Fragment>
              ))}
              .
            </>
          ) : null}
        </p>
      ) : null}
      <p className={c.fresh}>
        <Linked parts={C.source(record.updatedAt)} path={SOURCES.proof} />
      </p>
    </section>
  );
}

/** What a spend costs on mainnet, and a vault on testnet, with the file each figure comes from. */
export function CostsCard({
  gas = GAS,
  fees = BRIDGE_FEES,
  deposit = TESTNET_DEPOSIT,
}: {
  gas?: readonly GasCost[];
  fees?: readonly { usdc: string; payouts: number }[];
  deposit?: VaultDeposit | null;
}) {
  const C = COSTS_COPY;
  const readOn = [...new Set(gas.map((g) => g.readOn))].join(" and ");
  return (
    <section id="costs" className={brandCardClass}>
      <h2 className={c.cardTitle}>{C.title}</h2>
      <p className="max-w-measure">{C.lede}</p>
      <ScrollRegion label={K.label} className={c.scroll}>
        <table className={`${c.table} ${u.usage}`}>
          <thead>
            <tr>
              <th scope="col">{K.cost}</th>
              <th scope="col">{K.amount}</th>
            </tr>
          </thead>
          <tbody>
            {gas.map((g) => (
              <tr key={g.row.key}>
                <th scope="row">{C.gasLabel(g.row)}</th>
                <td>
                  <Source path={g.source} label={C.gasNear(g)} />
                  <br />
                  {C.gasTgas(g)}
                </td>
              </tr>
            ))}
            {fees.map((f) => (
              <tr key={f.usdc}>
                <th scope="row">{C.bridge(f.payouts)}</th>
                <td>
                  {C.bridgeAmount(f.usdc)}
                  <br />
                  <Source path={SOURCES.poaS1} label="S1 poa-status.json" />
                  <br />
                  <Source path={SOURCES.poaS2} label="S2 poa-status.json" />
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row">{C.probarion}</th>
              <td>
                {/* A sentence, so it may wrap, where the table's other cells keep each line whole. */}
                <span className="whitespace-normal">
                  <Source path={SOURCES.spend} label={C.probarionAmount} />
                </span>
              </td>
            </tr>
            {deposit === null ? null : (
              <tr>
                <th scope="row">{C.deposit}</th>
                <td>
                  {C.depositAmount(deposit.near)}
                  <br />
                  <Source path={SOURCES.testnetFactory} />
                  <br />
                  <Source path={SOURCES.runway} />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </ScrollRegion>
      {gas.length > 0 ? <p className={c.line}>{C.gasNote(readOn)}</p> : null}
      <p className={c.line}>{C.feeNote}</p>
      {deposit === null ? null : <p className={c.line}>{C.depositNote(deposit.minDepositNear)}</p>}
    </section>
  );
}
