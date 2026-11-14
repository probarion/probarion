/**
 * By hand, not in CI or a unit test: records the NEAR transactions of Probarion's two mainnet payouts to Base
 * (spends 2 and 3 of `v0.probarion.near`, 2026-11-13) into test/fixtures/poa/, with their receipt statuses, so the
 * POA withdrawal check runs on what the chain answered.
 *
 *   pnpm --filter @probarion/near record:poa
 *
 * Reads public data, signs nothing, and calls two methods on two public endpoints: NEAR `tx` (wait_until FINAL) on
 * archival-rpc.mainnet.fastnear.com, and the POA bridge's `withdrawal_status` on bridge.chaindefuser.com/rpc. The
 * bridge read is a cross-check: its records must equal the copies of the evidence answers already in
 * test/fixtures/poa (poa-status-s1.json, poa-status-s2.json), else nothing is written. `transaction.signature` is
 * dropped from each answer. Then commit the two files.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePoaWithdrawalStatus } from "../src/poa.js";
import { POA_BRIDGE_RPC_URL, readPoaWithdrawalStatus } from "../src/poa-rpc.js";
import { httpJsonRpc, type NearRpc } from "../src/rpc.js";

export const NEAR_ARCHIVAL_RPC_URL = "https://archival-rpc.mainnet.fastnear.com";
/** Every method this script sends. The script test pins it. */
export const RECORDER_METHODS = ["tx", "withdrawal_status"] as const;

/** The two payouts: spend 2 is the evidence folder s1-2026-11-13, spend 3 is s2-2026-11-13. */
export const POA_SPENDS = [
  {
    file: "mainnet-spend-2-tx.json",
    evidence: "poa-status-s1.json",
    spendId: 2,
    txHash: "BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9",
    sender: "v0.probarion.near",
  },
  {
    file: "mainnet-spend-3-tx.json",
    evidence: "poa-status-s2.json",
    spendId: 3,
    txHash: "5amtgb8MujUkiydS5Ht9Ut6AX6pN9SGegHUCHGsX9NGH",
    sender: "v0.probarion.near",
  },
] as const;

export type PoaSpend = (typeof POA_SPENDS)[number];

export interface RecordedTx {
  _source: string;
  request: { url: string; method: "tx"; params: Record<string, unknown> };
  result: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The `tx` params for a spend: its hash, its sender, and FINAL, so every receipt has its final status. */
export function txParams(spend: PoaSpend): Record<string, unknown> {
  return { tx_hash: spend.txHash, sender_account_id: spend.sender, wait_until: "FINAL" };
}

/**
 * Reads one spend: the transaction from `near`, and the bridge's records from `bridge`, which must equal
 * `evidenceAnswer` parsed. Returns the fixture to write; throws when a read fails or the bridge disagrees.
 */
export async function recordSpend(
  near: NearRpc,
  bridge: NearRpc,
  spend: PoaSpend,
  evidenceAnswer: unknown,
  now: Date,
): Promise<RecordedTx> {
  const params = txParams(spend);
  const answer = await near.call<unknown>("tx", params);
  if (!isObj(answer) || !isObj(answer.transaction) || !Array.isArray(answer.receipts_outcome)) {
    throw new Error(`spend ${spend.spendId}: the tx answer is not a transaction tree`);
  }
  if (answer.transaction.hash !== spend.txHash) {
    throw new Error(
      `spend ${spend.spendId}: the tx answer is for ${String(answer.transaction.hash)}`,
    );
  }
  const live = await readPoaWithdrawalStatus(bridge, spend.txHash);
  const recorded = parsePoaWithdrawalStatus(evidenceAnswer);
  if (JSON.stringify(live, bigintText) !== JSON.stringify(recorded, bigintText)) {
    throw new Error(
      `spend ${spend.spendId}: the bridge's records differ from ${spend.evidence}: ${JSON.stringify(live, bigintText)}`,
    );
  }
  const { signature: _signature, ...transaction } = answer.transaction;
  return {
    _source:
      `NEAR mainnet tx ${spend.txHash} (spend ${spend.spendId} of ${spend.sender}, a payout to Base through the POA ` +
      `bridge), read with JSON-RPC tx wait_until FINAL from ${new URL(NEAR_ARCHIVAL_RPC_URL).host} on ` +
      `${now.toISOString()} by packages/near/scripts/record-poa.ts. Reads of public data, nothing signed. transaction.signature ` +
      `dropped; everything else as answered, receipt statuses included. The POA bridge's withdrawal_status answer, ` +
      `read in the same run, equalled ${spend.evidence}.`,
    request: { url: NEAR_ARCHIVAL_RPC_URL, method: "tx", params },
    result: { ...answer, transaction },
  };
}

function bigintText(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

async function main(): Promise<void> {
  const near = httpJsonRpc(NEAR_ARCHIVAL_RPC_URL, { timeoutMs: 20_000 });
  const bridge = httpJsonRpc(POA_BRIDGE_RPC_URL, { timeoutMs: 20_000 });
  const now = new Date();
  const files: { path: string; body: RecordedTx }[] = [];
  for (const spend of POA_SPENDS) {
    const evidencePath = fileURLToPath(
      new URL(`../test/fixtures/poa/${spend.evidence}`, import.meta.url),
    );
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as { answer?: unknown };
    const body = await recordSpend(near, bridge, spend, evidence.answer, now);
    files.push({
      path: fileURLToPath(new URL(`../test/fixtures/poa/${spend.file}`, import.meta.url)),
      body,
    });
  }
  // Nothing is written unless both spends read cleanly.
  for (const { path, body } of files) writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  console.log(JSON.stringify({ wrote: files.map((f) => f.path) }));
}

// Runs when tsx starts this file, not when the script test imports it (then nothing is read).
if (/record-poa\.ts$/.test(process.argv[1] ?? "")) await main();
