// Example: prove one mainnet receipt without trusting the RPC node that served it. The head is read from two
// providers and cross-checked, the proof comes from an archival node, and verifyOutcomeProof recomputes the
// receipt's outcome, its block and that block's place under the head. The receipt is the POA token contract's
// burn in Probarion's mainnet spend 2: base-0x8335...omft.near burns the 1 USDC that intents.near withdrew for the
// vault, and its one log (an nep141 ft_burn event) carries the memo WITHDRAW_TO:<Base address> the bridge pays to.
//
//   pnpm --filter @probarion/near exec tsx examples/prove-receipt.ts
//
// An app imports the same names from "@probarion/near"; the example imports the source so it runs in the repo.
import { pathToFileURL } from "node:url";
import { verifyOutcomeProof } from "../src/outcome-proof.js";
import { fetchOutcomeProof, readCrossCheckedHead } from "../src/proof-rpc.js";
import { httpJsonRpc, type NearRpc } from "../src/rpc.js";
import type { TrustedHead } from "../src/types.js";

export const RECEIPT_ID = "D7Ux36fgy29tu5jjEoEstVwbLz3FXDP8Q2gDu65ZkK3b";
export const RECEIVER_ID = "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

export interface ProvenReceipt {
  receiptId: string;
  executorId: string;
  logs: readonly string[];
  /** The block whose header commits the outcome, and its height. */
  blockHash: string;
  height: number;
  head: Required<TrustedHead>;
}

/** Cross-checks a head on `rpcHead1` and `rpcHead2`, fetches the receipt's proof from `archival`, and verifies it. */
export async function proveReceipt(
  rpcHead1: NearRpc,
  rpcHead2: NearRpc,
  archival: NearRpc,
): Promise<ProvenReceipt> {
  const head = await readCrossCheckedHead(rpcHead1, rpcHead2);
  const proof = await fetchOutcomeProof(
    archival,
    { type: "receipt", receiptId: RECEIPT_ID, receiverId: RECEIVER_ID },
    head.hash,
  );
  const result = verifyOutcomeProof(proof, head, { id: RECEIPT_ID, executorId: RECEIVER_ID });
  if (!result.ok) throw new Error(`the proof does not verify: ${result.code}: ${result.detail}`);
  return {
    receiptId: result.outcome.id,
    executorId: result.outcome.executorId,
    logs: result.outcome.logs,
    blockHash: result.outcome.block.hash,
    height: result.outcome.block.height,
    head,
  };
}

// Run directly (not imported by a test): read the live chain with view calls; nothing is signed.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const proven = await proveReceipt(
    httpJsonRpc("https://rpc.mainnet.fastnear.com"),
    httpJsonRpc("https://rpc.intea.rs"),
    httpJsonRpc("https://archival-rpc.mainnet.fastnear.com"),
  );
  process.stdout.write(
    `receipt ${proven.receiptId} ran on ${proven.executorId} in block ${proven.blockHash} ` +
      `(height ${proven.height}), proven under head ${proven.head.hash} (height ${proven.head.height})\n`,
  );
  for (const log of proven.logs) process.stdout.write(`  log: ${log}\n`);
}
