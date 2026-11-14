// Opt-in recorder for the N1 fixtures. It reads public NEAR mainnet data with view calls and signs nothing; unit
// tests do not run it (they read what it wrote). It writes two files under test/fixtures/proofs/:
//
//   mainnet-spend-2.json         payout spend 2 of v0.probarion.near (tx BdN7oB76...): the tx answer, the head, the
//                                light_client_proof of the transaction and of every receipt in its tree, and the
//                                RPC's block hash at each proven height (an oracle for lightBlockHash)
//   mainnet-drill-over-cap.json  the drill's refused over-cap spend (tx G6WJcTZA...): the same, under the same head,
//                                and the id of its failed receipt
//
//   pnpm --filter @probarion/near run record:proofs
//
// RPC methods: block, tx and light_client_proof (ALLOWED_METHODS: any other call throws before it is sent). Every
// proof is verified before anything is written, so a run that records a proof the verifier refuses fails instead.
import { mkdir, writeFile } from "node:fs/promises";
import {
  lightBlockHash,
  verifyOutcomeProof,
  verifyTransactionOutcomes,
} from "../src/outcome-proof.js";
import { fetchOutcomeProof, readCrossCheckedHead } from "../src/proof-rpc.js";
import { httpJsonRpc, type NearRpc, NearRpcError } from "../src/rpc.js";
import type { TrustedHead } from "../src/types.js";

const ARCHIVAL_RPC = "https://archival-rpc.mainnet.fastnear.com";
const HEAD_RPC_PRIMARY = "https://rpc.mainnet.fastnear.com";
const HEAD_RPC_SECONDARY = "https://rpc.intea.rs";
const ALLOWED_METHODS: readonly string[] = ["block", "tx", "light_client_proof"];
const OUT_DIR = new URL("../test/fixtures/proofs/", import.meta.url);

const SENDER = "v0.probarion.near";
/** Mainnet spend 2: the vault's payout to Base through NEAR Intents (docs/mainnet-proof.json). */
const SPEND_2 = "BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9";
/** The drill's over-cap spend, refused by the vault on chain (PROBARION:OverPerPayment). */
const DRILL_OVER_CAP = "G6WJcTZA67NBSrLV8zhS7Ay5BQKt6qCSao7dndm1tF1c";

type Json = Record<string, unknown>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A network failure, an HTTP 429 or a 5xx is worth another try; a JSON-RPC error is not. */
function retryable(error: unknown): boolean {
  return (
    error instanceof NearRpcError &&
    (error.rpcError === null || /HTTP (429|5\d\d)/.test(error.message))
  );
}

/** Allows the three methods only, retries a rate limit or a network failure twice, and spaces calls out. */
function guarded(rpc: NearRpc): NearRpc {
  return {
    async call<T = unknown>(method: string, params: unknown): Promise<T> {
      if (!ALLOWED_METHODS.includes(method)) {
        throw new Error(`record-proofs: ${method} is not one of ${ALLOWED_METHODS.join(", ")}`);
      }
      for (let attempt = 1; ; attempt++) {
        await sleep(250);
        try {
          return await rpc.call<T>(method, params);
        } catch (error) {
          if (attempt >= 3 || !retryable(error)) throw error;
          await sleep(2000 * attempt);
        }
      }
    },
  };
}

function fail(message: string): never {
  process.stderr.write(`record-proofs: ${message}\n`);
  process.exit(1);
}

const archival = guarded(httpJsonRpc(ARCHIVAL_RPC));
const primary = guarded(httpJsonRpc(HEAD_RPC_PRIMARY));
const secondaryRpc = guarded(httpJsonRpc(HEAD_RPC_SECONDARY));
let secondaryAnswer: unknown;
const secondary: NearRpc = {
  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    const answer = await secondaryRpc.call<T>(method, params);
    secondaryAnswer = answer;
    return answer;
  },
};

/** The tx answer as served, minus `transaction.signature` (fixtures carry no signatures). */
async function readTx(txHash: string): Promise<Json> {
  const answer = await archival.call<Json>("tx", {
    tx_hash: txHash,
    sender_account_id: SENDER,
    wait_until: "FINAL",
  });
  const transaction = { ...(answer.transaction as Json) };
  delete transaction.signature;
  return { ...answer, transaction };
}

function receiptsOf(tx: Json): { id: string; executor: string; status: unknown }[] {
  return (tx.receipts_outcome as Json[]).map((entry) => {
    const outcome = entry.outcome as Json;
    return {
      id: entry.id as string,
      executor: outcome.executor_id as string,
      status: outcome.status,
    };
  });
}

/** `block {block_id: height}` on the archival RPC for every proven height, checked against lightBlockHash. */
async function blockHashByHeight(proofs: readonly Json[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const proof of proofs) {
    const lite = proof.block_header_lite as Json;
    const height = (lite.inner_lite as Json).height as number;
    if (out[height] !== undefined) continue;
    const block = await archival.call<Json>("block", { block_id: height });
    const hash = (block.header as Json).hash as string;
    if (lightBlockHash(lite) !== hash) {
      fail(`lightBlockHash at height ${height} is ${lightBlockHash(lite)}, the RPC says ${hash}`);
    }
    out[height] = hash;
  }
  return out;
}

function checkProof(proof: unknown, head: TrustedHead, label: string): void {
  const result = verifyOutcomeProof(proof, head, { status: "any" });
  if (!result.ok) fail(`${label}: ${result.code}: ${result.detail}`);
}

const recordedAt = new Date().toISOString();
const head = await readCrossCheckedHead(primary, secondary);
const secondaryHeader = (secondaryAnswer as Json).header as Json;
const headSecondary = {
  rpc: HEAD_RPC_SECONDARY,
  hash: secondaryHeader.hash,
  height: secondaryHeader.height,
  block_merkle_root: secondaryHeader.block_merkle_root,
};
process.stdout.write(`head ${head.hash} at height ${head.height}, cross-checked\n`);

function source(what: string): string {
  return [
    `${what}. Recorded ${recordedAt} by packages/near/scripts/record-proofs.ts`,
    "(pnpm --filter @probarion/near run record:proofs): NEAR mainnet view calls, nothing signed.",
    `head: block {finality: "final"} from ${HEAD_RPC_PRIMARY}, then the same block by hash from`,
    `${HEAD_RPC_SECONDARY} (head_secondary); hash, height and block_merkle_root agree.`,
    `tx (wait_until FINAL), light_client_proof (light_client_head = head.hash) and block by height from`,
    `${ARCHIVAL_RPC}. transaction.signature is dropped from the tx answer; everything else is as served.`,
  ].join(" ");
}

// ---------- spend 2 ----------

const spendTx = await readTx(SPEND_2);
const spendProofs: Json[] = [
  (await fetchOutcomeProof(
    archival,
    { type: "transaction", txHash: SPEND_2, senderId: SENDER },
    head.hash,
  )) as Json,
];
for (const receipt of receiptsOf(spendTx)) {
  spendProofs.push(
    (await fetchOutcomeProof(
      archival,
      { type: "receipt", receiptId: receipt.id, receiverId: receipt.executor },
      head.hash,
    )) as Json,
  );
}
spendProofs.forEach((proof, i) => {
  checkProof(proof, head, `spend 2 proof ${i}`);
});
const spendTree = verifyTransactionOutcomes(spendProofs, head, {
  txHash: SPEND_2,
  signerId: SENDER,
});
if (!spendTree.ok)
  fail(`spend 2 tree: ${spendTree.code} at ${spendTree.index}: ${spendTree.detail}`);
process.stdout.write(`spend 2: ${spendProofs.length} outcomes proven, linked and complete\n`);

// ---------- the drill's over-cap spend ----------

const drillTx = await readTx(DRILL_OVER_CAP);
const failed = receiptsOf(drillTx).find(
  (receipt) =>
    typeof receipt.status === "object" && receipt.status !== null && "Failure" in receipt.status,
);
if (failed === undefined) fail("the drill's tx answer has no failed receipt");
const drillProofs: Json[] = [
  (await fetchOutcomeProof(
    archival,
    { type: "transaction", txHash: DRILL_OVER_CAP, senderId: SENDER },
    head.hash,
  )) as Json,
];
for (const receipt of receiptsOf(drillTx)) {
  drillProofs.push(
    (await fetchOutcomeProof(
      archival,
      { type: "receipt", receiptId: receipt.id, receiverId: receipt.executor },
      head.hash,
    )) as Json,
  );
}
drillProofs.forEach((proof, i) => {
  checkProof(proof, head, `drill proof ${i}`);
});
const drillTree = verifyTransactionOutcomes(drillProofs, head, {
  txHash: DRILL_OVER_CAP,
  signerId: SENDER,
});
if (!drillTree.ok) fail(`drill tree: ${drillTree.code} at ${drillTree.index}: ${drillTree.detail}`);
const drillReceipt = verifyOutcomeProof(
  drillProofs.find((proof) => (proof.outcome_proof as Json).id === failed.id),
  head,
  { status: "failure" },
);
if (!drillReceipt.ok) fail(`drill receipt: ${drillReceipt.code}: ${drillReceipt.detail}`);
process.stdout.write(`drill: receipt ${failed.id} proven with status failure\n`);

// ---------- write ----------

await mkdir(OUT_DIR, { recursive: true });
const spendFixture = {
  _source: source(
    `Mainnet spend 2 of ${SENDER} (tx ${SPEND_2}): the tx answer, and the light_client_proof of the transaction (proofs[0]) and of each receipt of tx.receipts_outcome, in that order`,
  ),
  head,
  head_secondary: headSecondary,
  tx: spendTx,
  proofs: spendProofs,
  block_hash_by_height: await blockHashByHeight(spendProofs),
};
const drillFixture = {
  _source: source(
    `The drill's over-cap spend of ${SENDER} (tx ${DRILL_OVER_CAP}), refused on chain: the tx answer, and the light_client_proof of the transaction (proofs[0]) and of each receipt of tx.receipts_outcome, in that order; failed_receipt_id is the receipt the vault refused`,
  ),
  head,
  head_secondary: headSecondary,
  tx: drillTx,
  failed_receipt_id: failed.id,
  proofs: drillProofs,
  block_hash_by_height: await blockHashByHeight(drillProofs),
};
await writeFile(
  new URL("mainnet-spend-2.json", OUT_DIR),
  `${JSON.stringify(spendFixture, null, 2)}\n`,
);
await writeFile(
  new URL("mainnet-drill-over-cap.json", OUT_DIR),
  `${JSON.stringify(drillFixture, null, 2)}\n`,
);
process.stdout.write(
  "wrote test/fixtures/proofs/mainnet-spend-2.json and mainnet-drill-over-cap.json\n",
);
