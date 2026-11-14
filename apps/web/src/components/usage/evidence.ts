// What /usage shows of the mainnet vault and its costs, read from the committed evidence: docs/mainnet-proof.json, the
// run records and gas readings under docs/evidence/mainnet-v0, and the testnet factory's deployment record. The JSON is
// bundled at build time, so the page reads no file and no chain for it at run time, and none of it is added into the
// database counts. evidence.test.ts holds every figure to the files it comes from.

import { usdcFromUnits } from "@/lib/canary/format";
import { createDepositPlan, type FactoryMode } from "@/lib/near/runway";
import { formatNear } from "@/lib/near/units";
import { REPO_URL } from "@/lib/proof/cli";
import testnetDeployments from "../../../../../contracts/deployments/testnet.json";
import gasV0 from "../../../../../docs/evidence/mainnet-v0/gas-2026-11-13.json";
import gasSpend2 from "../../../../../docs/evidence/mainnet-v0/s1-2026-11-13/gas-spend-2.json";
import s1Refused0 from "../../../../../docs/evidence/mainnet-v0/s1-2026-11-13/outcome-20261113T071746Z.json";
import s1Refused1 from "../../../../../docs/evidence/mainnet-v0/s1-2026-11-13/outcome-20261113T072221Z.json";
import s1Paid from "../../../../../docs/evidence/mainnet-v0/s1-2026-11-13/outcome-20261113T072425Z.json";
import poaS1 from "../../../../../docs/evidence/mainnet-v0/s1-2026-11-13/poa-status.json";
import gasSpend3 from "../../../../../docs/evidence/mainnet-v0/s2-2026-11-13/gas-spend-3.json";
import s2Paid from "../../../../../docs/evidence/mainnet-v0/s2-2026-11-13/outcome-20261113T114028Z.json";
import poaS2 from "../../../../../docs/evidence/mainnet-v0/s2-2026-11-13/poa-status.json";
import proofJson from "../../../../../docs/mainnet-proof.json";

/** A file of this repository on GitHub, on main, where the site is deployed from. */
export const repoFile = (path: string): string => `${REPO_URL}/blob/main/${path}`;

/** One transaction of docs/mainnet-proof.json, with the fields this page reads. */
export interface ProofTx {
  amount_usdc: string | null;
  base_tx: string | null;
  error_code: string | null;
  hash: string;
  kind: string;
  network: string;
  receiver_id: string;
  recorded_at: string;
  spend_id: number | null;
}

export interface ProofRecord {
  accounts: { v0_vault: string };
  updated_at: string;
  txs: Record<string, ProofTx>;
}

/** A run record of the owner's kit (outcome-*.json): one decision cycle, and the spend it sent, if any. */
export interface RunOutcome {
  vault: string;
  network: string;
  verdict: string;
  decided_by: string;
  model: string | null;
  code: string | null;
  spend_tx: string | null;
  anchor_tx: string | null;
  ledger_seq: number;
  /** The decision's own ledger position, when the record's `ledger_seq` is the payment entry after it. */
  decision_seq?: number;
}

/** The POA bridge's status of one withdrawal to Base (poa-status.json). Amounts in USDC base units. */
export interface PoaStatus {
  status: string;
  data: {
    tx_hash: string;
    transfer_tx_hash: string;
    withdrawal_fee: string;
    withdraw_amount: string;
  };
}

/** A gas reading of one or more transactions, summed over the transaction and every receipt (gas-*.json). */
export interface GasReading {
  read_on: string;
  txs: { tx_hash: string; sum_tgas: string; sum_near: string }[];
}

/** The kinds of mainnet transaction the record shows: the ones that moved USDC or were refused on chain. */
export type RowKind = "near_payment" | "base_payout" | "refused_on_chain";
const ROW_KINDS: readonly string[] = ["near_payment", "base_payout", "refused_on_chain"];

export interface MainnetRow {
  /** The transaction's key in docs/mainnet-proof.json. */
  key: string;
  /** The UTC day it was recorded, which is the day of its block for every row so far. */
  day: string;
  kind: RowKind;
  spendId: number | null;
  /** USDC the spend sent, as recorded, or null for a refused spend. */
  amount: string | null;
  /** USDC that arrived on Base, from the bridge's status record, or null when the payment did not go to Base. */
  arrived: string | null;
  nearTx: string;
  baseTx: string | null;
  errorCode: string | null;
  /** How the run record says the spend was decided, or null when the spend has no run record. */
  decidedBy: "model+rules" | "rules-only" | null;
  model: string | null;
  /** Recorded before the vault's first anchor, so before its signed ledger began. */
  beforeLedger: boolean;
}

/** A decision a model proposed and the code rules then judged, from the run records. */
export interface ModelDecision {
  seq: number;
  verdict: string;
  model: string | null;
  /** The code rule that refused it, for a refusal. */
  code: string | null;
  spendTx: string | null;
  anchorTx: string | null;
}

export interface MainnetRecord {
  vault: string;
  updatedAt: string;
  rows: MainnetRow[];
  /** Spends that moved USDC: on NEAR and to Base. */
  payments: number;
  basePayouts: number;
  refusedOnChain: number;
  /** Decisions made by a model and the code rules. Each one carries the model's TEE evidence. */
  decisions: ModelDecision[];
  decisionsPaid: number;
  decisionsRefused: number;
}

/** "2026-11-13" for an ISO time, read in UTC. */
const utcDay = (iso: string): string => new Date(Date.parse(iso)).toISOString().slice(0, 10);

const decidedBy = (o: RunOutcome | undefined): MainnetRow["decidedBy"] =>
  o?.decided_by === "model+rules" || o?.decided_by === "rules-only" ? o.decided_by : null;

/**
 * The mainnet vault's payments and refusals on chain, oldest first, joined with the run record that sent each one and
 * the bridge's status of each Base payout. Testnet transactions and setup steps (deploy, mandates, keys, anchors) are
 * left out.
 */
export function buildMainnetRecord(
  proof: ProofRecord,
  outcomes: readonly RunOutcome[],
  bridge: readonly PoaStatus[],
): MainnetRecord {
  const vault = proof.accounts.v0_vault;
  const ours = outcomes.filter((o) => o.network === "mainnet" && o.vault === vault);
  const anchors = Object.values(proof.txs)
    .filter((t) => t.network === "mainnet" && t.receiver_id === vault && t.kind === "anchor")
    .map((t) => Date.parse(t.recorded_at));
  const ledgerFrom = anchors.length > 0 ? Math.min(...anchors) : Number.POSITIVE_INFINITY;
  const rows: MainnetRow[] = Object.entries(proof.txs)
    .filter(
      ([, t]) => t.network === "mainnet" && t.receiver_id === vault && ROW_KINDS.includes(t.kind),
    )
    .map(([key, t]) => {
      const run = ours.find((o) => o.spend_tx === t.hash);
      const release = bridge.find(
        (b) =>
          b.status === "COMPLETED" &&
          b.data.tx_hash === t.hash &&
          b.data.transfer_tx_hash === t.base_tx,
      );
      return {
        key,
        day: utcDay(t.recorded_at),
        kind: t.kind as RowKind,
        spendId: t.spend_id,
        amount: t.amount_usdc,
        arrived:
          t.kind === "base_payout" && release ? usdcFromUnits(release.data.withdraw_amount) : null,
        nearTx: t.hash,
        baseTx: t.base_tx,
        errorCode: t.error_code,
        decidedBy: decidedBy(run),
        model: run?.model ?? null,
        beforeLedger: Date.parse(t.recorded_at) < ledgerFrom,
      };
    })
    .sort((a, b) => {
      const at = (r: MainnetRow) => Date.parse(proof.txs[r.key]?.recorded_at ?? "");
      return (
        at(a) - at(b) ||
        (a.spendId ?? Number.MAX_SAFE_INTEGER) - (b.spendId ?? Number.MAX_SAFE_INTEGER)
      );
    });
  const decisions: ModelDecision[] = ours
    .filter((o) => o.decided_by === "model+rules")
    .map((o) => ({
      // A refusal's record is at its decision's entry; a payment's is at the payment entry and names the decision.
      seq: o.decision_seq ?? o.ledger_seq,
      verdict: o.verdict,
      model: o.model,
      code: o.code,
      spendTx: o.spend_tx,
      anchorTx: o.anchor_tx,
    }))
    .sort((a, b) => a.seq - b.seq);
  const paid = rows.filter((r) => r.kind !== "refused_on_chain");
  return {
    vault,
    updatedAt: proof.updated_at,
    rows,
    payments: paid.length,
    basePayouts: rows.filter((r) => r.kind === "base_payout").length,
    refusedOnChain: rows.filter((r) => r.kind === "refused_on_chain").length,
    decisions,
    decisionsPaid: decisions.filter((d) => d.verdict === "allow" && d.spendTx !== null).length,
    decisionsRefused: decisions.filter((d) => d.verdict === "refuse").length,
  };
}

/** One gas figure: what one spend burned, with the reading it comes from. */
export interface GasCost {
  row: MainnetRow;
  tgas: string;
  near: string;
  readOn: string;
  /** The evidence file, a repository path. */
  source: string;
}

/** The gas each payment and refusal of the record burned, in the record's order, for the rows that have a reading. */
export function gasCosts(
  rows: readonly MainnetRow[],
  readings: readonly { source: string; reading: GasReading }[],
): GasCost[] {
  return rows.flatMap((row) => {
    for (const { source, reading } of readings) {
      const tx = reading.txs.find((t) => t.tx_hash === row.nearTx);
      if (tx)
        return [{ row, tgas: tx.sum_tgas, near: tx.sum_near, readOn: reading.read_on, source }];
    }
    return [];
  });
}

/** The bridge's fee on each Base payout, in USDC: one entry per distinct fee, with the payouts it applied to. */
export function bridgeFees(bridge: readonly PoaStatus[]): { usdc: string; payouts: number }[] {
  const by = new Map<string, number>();
  for (const b of bridge.filter((x) => x.status === "COMPLETED")) {
    const fee = usdcFromUnits(b.data.withdrawal_fee);
    if (fee !== null) by.set(fee, (by.get(fee) ?? 0) + 1);
  }
  return [...by].map(([usdc, payouts]) => ({ usdc, payouts }));
}

/**
 * What the console asks to create a vault with the testnet factory: its `min_deposit` plus the console's estimate of the
 * storage for the vault's copy of the code (createDepositPlan), for the last version the record lists.
 */
export function testnetVaultDeposit(factory: {
  min_deposit: string;
  versions: { mode: string }[];
}): VaultDeposit | null {
  const mode = factory.versions.at(-1)?.mode;
  if (mode !== "embedded" && mode !== "global") return null;
  const required = createDepositPlan(factory.min_deposit, mode as FactoryMode, 0n).requiredYocto;
  return {
    near: formatNear(required.toString(), 6),
    minDepositNear: formatNear(factory.min_deposit, 6),
  };
}

/** A vault deposit in NEAR, and the factory's own `min_deposit` within it. */
export interface VaultDeposit {
  near: string;
  minDepositNear: string;
}

const MAINNET_V0 = "docs/evidence/mainnet-v0";

/** The evidence files, as repository paths: the page links each one. */
export const SOURCES = {
  proof: "docs/mainnet-proof.json",
  v0: `${MAINNET_V0}/README.md`,
  s1: `${MAINNET_V0}/s1-2026-11-13/README.md`,
  s1FalseRefusals: `${MAINNET_V0}/s1-2026-11-13/README.md#why-the-payout-was-decided-rules-only`,
  s2: `${MAINNET_V0}/s2-2026-11-13/README.md`,
  verifyOnline: `${MAINNET_V0}/s2-2026-11-13/verify-online-2026-11-13.txt`,
  gasV0: `${MAINNET_V0}/gas-2026-11-13.json`,
  gasSpend2: `${MAINNET_V0}/s1-2026-11-13/gas-spend-2.json`,
  gasSpend3: `${MAINNET_V0}/s2-2026-11-13/gas-spend-3.json`,
  poaS1: `${MAINNET_V0}/s1-2026-11-13/poa-status.json`,
  poaS2: `${MAINNET_V0}/s2-2026-11-13/poa-status.json`,
  spend: "contracts/vault/src/spend.rs",
  testnetFactory: "contracts/deployments/testnet.json",
  runway: "apps/web/src/lib/near/runway.ts",
} as const;

export const BRIDGE: readonly PoaStatus[] = [poaS1, poaS2] as PoaStatus[];

export const RUN_OUTCOMES: readonly RunOutcome[] = [
  s1Refused0,
  s1Refused1,
  s1Paid,
  s2Paid,
] as RunOutcome[];

export const MAINNET_RECORD: MainnetRecord = buildMainnetRecord(
  proofJson as unknown as ProofRecord,
  RUN_OUTCOMES,
  BRIDGE,
);

export const GAS: readonly GasCost[] = gasCosts(MAINNET_RECORD.rows, [
  { source: SOURCES.gasV0, reading: gasV0 as GasReading },
  { source: SOURCES.gasSpend2, reading: gasSpend2 as GasReading },
  { source: SOURCES.gasSpend3, reading: gasSpend3 as GasReading },
]);

export const BRIDGE_FEES = bridgeFees(BRIDGE);

/** In test NEAR, or null when the record names no factory version. */
export const TESTNET_DEPOSIT: VaultDeposit | null = testnetVaultDeposit(testnetDeployments.factory);
